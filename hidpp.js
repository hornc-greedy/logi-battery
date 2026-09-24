import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { logUnlessCancelled } from './utils.js';

Gio._promisify(GioUnix.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');

const LOGITECH_VENDOR_ID = '046D';

const BUS_USB = '0003';

// Logitech receiver (Unifying/Bolt/Nano) product ID range
const RECEIVER_PRODUCT_ID_MIN = 0xc500;
const RECEIVER_PRODUCT_ID_MAX = 0xc5ff;

// A receiver the kernel's hid-logitech-dj driver has not claimed
const UNDRIVEN_RECEIVER_DRIVER = 'hid-generic';

const HIDPP_SHORT_MESSAGE_ID = 0x10;
const HIDPP_LONG_MESSAGE_ID = 0x11;
const HIDPP_CONNECTION_NOTIFICATION = 0x41;
const HIDPP_LINK_STATUS_MASK = 0x40;
const HIDPP_EVENT_FUNCTION_SW_ID = 0x00;

const RECEIVER_DEVNUMBER = 0xff;
const GET_SHORT_REGISTER = 0x81;
const REG_RECEIVER_CONNECTION = 0x02;

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

const REQUEST_TIMEOUT_SECONDS = 5;

async function tryReadUevent(path, cancellable) {
    try {
        const [contents] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return contents;
    } catch {
        return null;
    }
}

async function discoverUndrivenReceivers(cancellable) {
    const dir = Gio.File.new_for_path('/sys/class/hidraw');
    const enumerator = await dir.enumerate_children_async(
        'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    const paths = [];

    let infos;
    while ((infos = await enumerator.next_files_async(10, GLib.PRIORITY_DEFAULT, cancellable)).length) {
        for (const info of infos) {
            const name = info.get_name();
            const devicePath = `/sys/class/hidraw/${name}/device`;

            const contents = await tryReadUevent(`${devicePath}/uevent`, cancellable);
            if (!contents)
                continue;

            const uevent = new TextDecoder().decode(contents);
            const [, bus, vendor, product] = uevent.match(/HID_ID=([0-9A-F]{4}):0000([0-9A-F]{4}):0000([0-9A-F]{4})/);
            const productId = parseInt(product, 16);
            if (bus !== BUS_USB || vendor !== LOGITECH_VENDOR_ID
                || productId < RECEIVER_PRODUCT_ID_MIN || productId > RECEIVER_PRODUCT_ID_MAX)
                continue;

            if (!uevent.includes(`DRIVER=${UNDRIVEN_RECEIVER_DRIVER}\n`))
                continue;

            // The HID++ interface has no input node, unlike the keyboard and mouse interfaces
            if (GLib.file_test(`${devicePath}/input`, GLib.FileTest.IS_DIR))
                continue;

            paths.push(`/dev/${name}`);
        }
    }

    return paths;
}

function tryOpenLink(path, logger) {
    try {
        return new HidppReceiverLink(path, logger);
    } catch {
        return null;
    }
}

function isConnectionNotification(data) {
    return data[0] === HIDPP_SHORT_MESSAGE_ID && data[2] === HIDPP_CONNECTION_NOTIFICATION;
}

// The device-info byte of a connection notification sets this bit while the link is down
function isLinkEstablished(data) {
    return !(data[4] & HIDPP_LINK_STATUS_MASK);
}

function isCharging(statusByte) {
    return CHARGING_STATUSES.has(BATTERY_STATUS_NAMES[statusByte]);
}

// HID++ devices push battery and status events unsolicited
class HidppReceiverLink extends GObject.Object {
    static [GObject.signals] = {
        'changed': {},
        'disconnected': {},
    };

    static {
        GObject.registerClass(this);
    }

    constructor(path, logger) {
        super();

        const ioStream = Gio.File.new_for_path(path).open_readwrite(null);
        const fd = ioStream.get_input_stream().get_fd();

        this.path = path;
        this._logger = logger;
        this._ioStream = ioStream;
        this._input = new GioUnix.InputStream({ fd, close_fd: false });
        this._output = new GioUnix.OutputStream({ fd, close_fd: false });
        this._cancellable = new Gio.Cancellable();
        this._waiters = [];
        this._devices = new Map();

        this._readLoop();
    }

    close() {
        this._cancellable.cancel();
        this._ioStream.close(null);

        this._waiters.forEach(waiter => {
            GLib.Source.remove(waiter.timeoutId);
            waiter.reject(new Gio.IOErrorEnum({ code: Gio.IOErrorEnum.CANCELLED, message: 'HID++ link closed' }));
        });
        this._waiters = [];
        this._devices.clear();
        this._refreshPending = false;
    }

    getDevices() {
        return Array.from(this._devices.values(), ({ kind, percent, charging }) => ({ kind, percent, charging, isBluetooth: false }));
    }

    async _readLoop() {
        for (;;) {
            let bytes;
            try {
                bytes = await this._input.read_bytes_async(32, GLib.PRIORITY_DEFAULT, this._cancellable);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    this.close();
                    this.emit('disconnected');
                }
                return;
            }

            const data = bytes.get_data();

            if (isConnectionNotification(data)) {
                if (isLinkEstablished(data)) {
                    this.refreshDevices();
                } else {
                    this._devices.delete(data[1]);
                    this.emit('changed');
                }
            }

            this._handleBatteryEvent(data);

            this._waiters = this._waiters.filter(waiter => {
                if (data[1] === waiter.devnumber && data[2] === waiter.hi && data[3] === waiter.lo) {
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

        const device = this._devices.get(data[1]);
        if (!device || device.batteryFeatureIndex !== data[2])
            return;

        device.percent = data[4];
        device.charging = isCharging(data[6]);

        this.emit('changed');
    }

    _request(devnumber, requestId, params = [], long = false) {
        const size = long ? 20 : 7;
        const data = new Uint8Array(size);
        data[0] = long ? HIDPP_LONG_MESSAGE_ID : HIDPP_SHORT_MESSAGE_ID;
        data[1] = devnumber;
        data[2] = (requestId >> 8) & 0xff;
        data[3] = requestId & 0xff;
        data.set(params, 4);

        this._output.write_bytes(new GLib.Bytes(data), null);

        return new Promise((resolve, reject) => {
            const waiter = {
                devnumber, hi: data[2], lo: data[3], reject,
                timeoutId: GLib.timeout_add_seconds_once(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_SECONDS, () => {
                    this._waiters = this._waiters.filter(w => w !== waiter);
                    reject(new Gio.IOErrorEnum({ code: Gio.IOErrorEnum.TIMED_OUT, message: 'HID++ request timed out' }));
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
            const kind = nameFeatureIndex ? await this._getDeviceKind(devnumber, nameFeatureIndex) : 'other';

            this._devices.set(devnumber, { kind, batteryFeatureIndex, percent, charging: isCharging(statusByte) });
        } catch (e) {
            logUnlessCancelled(this._logger, e, `${this.path} devnumber 0x${devnumber.toString(16)} unresponsive`);
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
            const count = await this._getConnectedDeviceCount();
            const devnumbers = Array.from({ length: count }, (_, i) => i + 1);
            await Promise.all(devnumbers.map(devnumber => this._refreshDevice(devnumber)));

            for (const devnumber of this._devices.keys()) {
                if (devnumber > count)
                    this._devices.delete(devnumber);
            }
        } catch (e) {
            logUnlessCancelled(this._logger, e, `refreshDevices on ${this.path} failed`);
        } finally {
            this._refreshing = false;
        }

        this.emit('changed');

        if (this._refreshPending) {
            this._refreshPending = false;
            await this.refreshDevices();
        }
    }
}

// Speaks HID++ to receivers the kernel does not drive, reachable through the udev rule in udev/
export class HidppReceiverMonitor extends GObject.Object {
    static [GObject.signals] = {
        'changed': {},
    };

    static {
        GObject.registerClass(this);
    }

    constructor(logger) {
        super();

        this._logger = logger;
        this._cancellable = new Gio.Cancellable();
        this._links = [];

        // udev sets the ACL after the node appears, which arrives as an attribute change
        this._devMonitor = Gio.File.new_for_path('/dev').monitor_directory(Gio.FileMonitorFlags.NONE, null);
        this._devMonitor.connectObject('changed', (_monitor, file) => {
            if (file.get_basename().startsWith('hidraw'))
                this._connectReceivers();
        }, this);

        this._connectReceivers();
    }

    destroy() {
        this._cancellable.cancel();
        this._devMonitor.disconnectObject(this);
        this._devMonitor.cancel();

        this._links.forEach(link => {
            link.disconnectObject(this);
            link.close();
        });
        this._links = [];
    }

    getDevices() {
        return this._links.flatMap(link => link.getDevices());
    }

    async _connectReceivers() {
        let paths;
        try {
            paths = await discoverUndrivenReceivers(this._cancellable);
        } catch (e) {
            logUnlessCancelled(this._logger, e, 'receiver discovery failed');
            return;
        }

        const knownPaths = new Set(this._links.map(link => link.path));

        for (const path of paths) {
            if (knownPaths.has(path))
                continue;

            const link = tryOpenLink(path, this._logger);
            if (!link)
                continue;

            link.connectObject(
                'changed', () => this.emit('changed'),
                'disconnected', () => {
                    link.disconnectObject(this);
                    this._links = this._links.filter(l => l !== link);
                    this.emit('changed');
                },
                this);
            this._links.push(link);
            link.refreshDevices();
        }
    }
}
