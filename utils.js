import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

Gio._promisify(GioUnix.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');

const LOGITECH_VENDOR_ID = '046D';

const BUS_USB = '0003';
const BUS_BLUETOOTH = '0005';

// Logitech receiver (Unifying/Bolt/Nano) product ID range
const RECEIVER_PRODUCT_ID_MIN = 0xc500;
const RECEIVER_PRODUCT_ID_MAX = 0xc5ff;

const HIDPP_SHORT_MESSAGE_ID = 0x10;
const HIDPP_LONG_MESSAGE_ID = 0x11;
const HIDPP_CONNECTION_NOTIFICATION = 0x41;
const HIDPP_EVENT_FUNCTION_SW_ID = 0x00;

const RECEIVER_DEVNUMBER = 0xff;
const GET_SHORT_REGISTER = 0x81;
const REG_RECEIVER_CONNECTION = 0x02;

// Direct HID++2.0 devices use devnumber 0xFF, falling back to 0x00
const DIRECT_DEVNUMBER_CANDIDATES = [0xff, 0x00];

const ROOT_FEATURE_INDEX = 0x00;
const ROOT_GET_FEATURE_FUNCTION = 0x00;
const OUR_SOFTWARE_ID = 0x01;

const FEATURE_DEVICE_NAME = 0x0005;
const FEATURE_UNIFIED_BATTERY = 0x1004;

const CHARGING_STATUSES = new Set(['RECHARGING', 'ALMOST_FULL', 'FULL', 'SLOW_RECHARGE']);
const BATTERY_STATUS_NAMES = [
    'DISCHARGING', 'RECHARGING', 'ALMOST_FULL', 'FULL', 'SLOW_RECHARGE', 'INVALID_BATTERY', 'THERMAL_ERROR',
];
const DEVICE_KIND_NAMES = [
    'keyboard', 'remote_control', 'numpad', 'mouse', 'touchpad', 'trackball', 'presenter', 'receiver',
];

// Idle Bluetooth devices in sniff mode need longer to wake for their first reply
const REQUEST_TIMEOUT_SECONDS = 5;

async function tryReadUevent(path, cancellable) {
    try {
        const [contents] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return contents;
    } catch {
        return null;
    }
}

export async function discoverHidppInterfaces(cancellable = null) {
    const dir = Gio.File.new_for_path('/sys/class/hidraw');
    const enumerator = await dir.enumerate_children_async(
        'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    const interfaces = [];

    let infos;
    while ((infos = await enumerator.next_files_async(10, GLib.PRIORITY_DEFAULT, cancellable)).length) {
        for (const info of infos) {
            const name = info.get_name();
            const devicePath = `/sys/class/hidraw/${name}/device`;

            const contents = await tryReadUevent(`${devicePath}/uevent`, cancellable);
            if (!contents)
                continue;

            const match = new TextDecoder().decode(contents).match(/HID_ID=([0-9A-Fa-f]+):0000([0-9A-Fa-f]{4}):0000([0-9A-Fa-f]{4})/);
            if (!match)
                continue;

            const [, bus, vendor, product] = match;
            if (vendor.toUpperCase() !== LOGITECH_VENDOR_ID)
                continue;

            const isBluetooth = bus.toUpperCase() === BUS_BLUETOOTH;

            // The real USB HID++ interface has no input node, unlike the compat interfaces
            if (!isBluetooth && GLib.file_test(`${devicePath}/input`, GLib.FileTest.IS_DIR))
                continue;

            const productId = parseInt(product, 16);
            const isReceiver = bus.toUpperCase() === BUS_USB
                && productId >= RECEIVER_PRODUCT_ID_MIN && productId <= RECEIVER_PRODUCT_ID_MAX;

            interfaces.push({ path: `/dev/${name}`, isReceiver });
        }
    }

    return interfaces;
}

export function watchHidrawDirectory(callback) {
    const monitor = Gio.File.new_for_path('/dev').monitor_directory(Gio.FileMonitorFlags.NONE, null);
    const signalId = monitor.connect('changed', (source, file) => {
        if (file.get_basename().startsWith('hidraw'))
            callback();
    });
    return {
        cancel() {
            monitor.disconnect(signalId);
            monitor.cancel();
        },
    };
}

function isConnectionNotification(data) {
    return data.length >= 3 && data[0] === HIDPP_SHORT_MESSAGE_ID && data[2] === HIDPP_CONNECTION_NOTIFICATION;
}

function isCharging(statusByte) {
    return CHARGING_STATUSES.has(BATTERY_STATUS_NAMES[statusByte]);
}

export function deviceKindIconName(kind) {
    switch (kind) {
    case 'keyboard': return 'input-keyboard-symbolic';
    case 'mouse': return 'input-mouse-symbolic';
    default: return 'input-gaming-symbolic';
    }
}

export function batteryLevel(percent) {
    if (percent >= 80)
        return 'full';
    if (percent >= 50)
        return 'good';
    if (percent >= 20)
        return 'low';
    return 'caution';
}

export function batteryLevelIconName(level, charging) {
    return `battery-${level}${charging ? '-charging' : ''}-symbolic`;
}

export function batteryLevelColor(level) {
    switch (level) {
    case 'caution': return '#e01b24';
    case 'low': return '#e5a50a';
    default: return '#2ec27e';
    }
}

// HID++ devices push battery and status events unsolicited
export class HidppLink {
    constructor(path, { isReceiver }) {
        const ioStream = Gio.File.new_for_path(path).open_readwrite(null);
        const fd = ioStream.get_input_stream().get_fd();

        this.path = path;
        this._isReceiver = isReceiver;
        this._ioStream = ioStream;
        this._input = new GioUnix.InputStream({ fd, close_fd: false });
        this._output = new GioUnix.OutputStream({ fd, close_fd: false });
        this._cancellable = new Gio.Cancellable();
        this._waiters = [];
        this._devices = new Map();
        this.onChange = null;
        this.onDisconnect = null;

        this._readLoop();
    }

    close() {
        this._cancellable.cancel();
        this._ioStream.close(null);

        this._waiters.forEach(waiter => {
            GLib.Source.remove(waiter.timeoutId);
            waiter.reject(new Error('HID++ link closed'));
        });
        this._waiters = [];
    }

    getDevices() {
        return Array.from(this._devices.values())
            .map(({ name, kind, percent, charging, isBluetooth }) => ({ name, kind, percent, charging, isBluetooth }));
    }

    async _readLoop() {
        for (;;) {
            let bytes;
            try {
                bytes = await this._input.read_bytes_async(32, GLib.PRIORITY_DEFAULT, this._cancellable);
            } catch {
                if (!this._cancellable.is_cancelled()) {
                    this._devices.clear();
                    this.onChange?.();
                    this.onDisconnect?.();
                }
                return;
            }

            const data = bytes.get_data();

            // No receiver: any traffic before a device resolves means it just woke up
            if (isConnectionNotification(data) || (!this._isReceiver && !this._devices.size))
                this.refreshDevices().catch(() => {});

            this._handleBatteryEvent(data);

            this._waiters = this._waiters.filter(waiter => {
                // A direct link may reply on devnumber 0x00 or 0xFF interchangeably
                const devnumberMatches = data[1] === waiter.devnumber || data[1] === (waiter.devnumber ^ 0xff);
                if (data.length >= 4 && devnumberMatches && data[2] === waiter.hi && data[3] === waiter.lo) {
                    waiter.resolve(data);
                    return false;
                }
                return true;
            });
        }
    }

    _handleBatteryEvent(data) {
        if (data[0] !== HIDPP_LONG_MESSAGE_ID || data[3] !== HIDPP_EVENT_FUNCTION_SW_ID)
            return;

        // A direct link may push events under either devnumber
        const device = this._devices.get(data[1]) ?? this._devices.get(data[1] ^ 0xff);
        if (!device || device.batteryFeatureIndex !== data[2])
            return;

        device.percent = data[4];
        device.charging = isCharging(data[6]);

        this.onChange?.();
    }

    _request(devnumber, requestId, params = [], long = false) {
        // Direct connections always use the long report format
        const useLong = long || !this._isReceiver;
        const size = useLong ? 20 : 7;
        const data = new Uint8Array(size);
        data[0] = useLong ? HIDPP_LONG_MESSAGE_ID : HIDPP_SHORT_MESSAGE_ID;
        data[1] = devnumber;
        data[2] = (requestId >> 8) & 0xff;
        data[3] = requestId & 0xff;
        data.set(params, 4);

        this._output.write_bytes(new GLib.Bytes(data), null);

        return new Promise((resolve, reject) => {
            const waiter = {
                devnumber, hi: data[2], lo: data[3], reject,
                timeoutId: GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_SECONDS, () => {
                    this._waiters = this._waiters.filter(w => w !== waiter);
                    reject(new Error('HID++ request timed out'));
                    return GLib.SOURCE_REMOVE;
                }),
                resolve: reply => {
                    GLib.Source.remove(waiter.timeoutId);
                    resolve(reply);
                },
            };
            this._waiters.push(waiter);
        });
    }

    async _getConnectedDeviceCount() {
        const reply = await this._request(RECEIVER_DEVNUMBER, (GET_SHORT_REGISTER << 8) | REG_RECEIVER_CONNECTION);
        return reply[5];
    }

    async _resolveDirectDevnumber() {
        if (this._directDevnumber !== undefined)
            return this._directDevnumber;

        for (const candidate of DIRECT_DEVNUMBER_CANDIDATES) {
            try {
                await this._getFeatureIndex(candidate, FEATURE_UNIFIED_BATTERY);
                this._directDevnumber = candidate;
                return candidate;
                // eslint-disable-next-line no-empty -- resolved 0 vs. thrown must stay distinguishable
            } catch {}
        }

        return undefined;
    }

    // Feature index and function number pack into the request ID
    _callFeature(devnumber, featureIndex, func, params = [], long = false) {
        const requestId = (featureIndex << 8) | (func << 4) | OUR_SOFTWARE_ID;
        return this._request(devnumber, requestId, params, long);
    }

    async _getFeatureIndex(devnumber, featureId) {
        const params = [(featureId >> 8) & 0xff, featureId & 0xff];
        const reply = await this._callFeature(devnumber, ROOT_FEATURE_INDEX, ROOT_GET_FEATURE_FUNCTION, params);
        return reply[4];
    }

    async _getBatteryStatus(devnumber, featureIndex) {
        const reply = await this._callFeature(devnumber, featureIndex, 1, [], true);
        return { percent: reply[4], statusByte: reply[6] };
    }

    async _getDeviceKind(devnumber, featureIndex) {
        const reply = await this._callFeature(devnumber, featureIndex, 2, []);
        return DEVICE_KIND_NAMES[reply[4]] || 'other';
    }

    async _getDeviceName(devnumber, featureIndex) {
        const lengthReply = await this._callFeature(devnumber, featureIndex, 0, []);
        const nameLength = lengthReply[4];

        const bytes = [];
        while (bytes.length < nameLength) {
            const reply = await this._callFeature(devnumber, featureIndex, 1, [bytes.length], true);
            const remaining = nameLength - bytes.length;
            for (let i = 0; i < Math.min(16, remaining); i++)
                bytes.push(reply[4 + i]);
        }
        return new TextDecoder().decode(new Uint8Array(bytes));
    }

    async _refreshDevice(devnumber) {
        try {
            const batteryFeatureIndex = await this._getFeatureIndex(devnumber, FEATURE_UNIFIED_BATTERY);
            if (!batteryFeatureIndex) {
                this._devices.delete(devnumber);
                return;
            }

            const [nameFeatureIndex, { percent, statusByte }] = await Promise.all([
                this._getFeatureIndex(devnumber, FEATURE_DEVICE_NAME),
                this._getBatteryStatus(devnumber, batteryFeatureIndex),
            ]);
            const [name, kind] = nameFeatureIndex
                ? await Promise.all([
                    this._getDeviceName(devnumber, nameFeatureIndex),
                    this._getDeviceKind(devnumber, nameFeatureIndex),
                ])
                : ['Unknown device', 'other'];
            const charging = isCharging(statusByte);

            const isBluetooth = !this._isReceiver;
            this._devices.set(devnumber, { name, kind, batteryFeatureIndex, percent, charging, isBluetooth });
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                console.error(`logi-battery: ${this.path} devnumber 0x${devnumber.toString(16)} unresponsive: ${e.message}`);
            this._devices.delete(devnumber);
        }
    }

    async refreshDevices() {
        if (this._refreshing) {
            this._refreshPending = true;
            return;
        }
        this._refreshing = true;

        try {
            if (this._isReceiver) {
                const count = await this._getConnectedDeviceCount();
                const devnumbers = Array.from({ length: count }, (_, i) => i + 1);
                await Promise.all(devnumbers.map(devnumber => this._refreshDevice(devnumber)));

                for (const devnumber of this._devices.keys()) {
                    if (devnumber > count)
                        this._devices.delete(devnumber);
                }
            } else {
                const devnumber = await this._resolveDirectDevnumber();
                if (devnumber !== undefined)
                    await this._refreshDevice(devnumber);
            }
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                console.error(`logi-battery: refreshDevices on ${this.path} failed: ${e.message}`);
        } finally {
            this._refreshing = false;
        }

        this.onChange?.();

        if (this._refreshPending) {
            this._refreshPending = false;
            await this.refreshDevices();
        }
    }
}
