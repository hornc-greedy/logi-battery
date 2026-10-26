import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {isCancelled, logUnlessCancelled} from './utils.js';

Gio._promisify(GioUnix.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');

const LOGITECH_VENDOR_ID = '0000046D';

const BUS_USB = '0003';

// Logitech receiver (Unifying/Bolt/Nano) product ID range
const RECEIVER_PRODUCT_ID_MIN = 0xc500;
const RECEIVER_PRODUCT_ID_MAX = 0xc5ff;

// A receiver the kernel's hid-logitech-dj driver has not claimed
const UNDRIVEN_RECEIVER_DRIVER = 'hid-generic';

const HIDPP_SHORT_MESSAGE_ID = 0x10;
const HIDPP_LONG_MESSAGE_ID = 0x11;
const HIDPP_DISCONNECTION_NOTIFICATION = 0x40;
const HIDPP_PERMANENT_DISCONNECTION = 0x02;
const HIDPP_CONNECTION_NOTIFICATION = 0x41;
const HIDPP_LINK_STATUS_MASK = 0x40;
const HIDPP_EVENT_FUNCTION_SW_ID = 0x00;

const RECEIVER_DEVNUMBER = 0xff;
const SET_SHORT_REGISTER = 0x80;
const GET_SHORT_REGISTER = 0x81;
const REG_ENABLE_REPORTS = 0x00;
const REG_CONNECTION_STATE = 0x02;
const FAKE_DEVICE_ARRIVAL = 0x02;

// Measured on the Bolt receiver, which starts with it cleared and then sends no connection notifications
const ENABLE_WIRELESS_NOTIFICATIONS_BYTE = 1;
const ENABLE_WIRELESS_NOTIFICATIONS = 0x01;

const ROOT_FEATURE_INDEX = 0x00;
const ROOT_GET_FEATURE_FUNCTION = 0x00;
const OUR_SOFTWARE_ID = 0x01;

const FEATURE_DEVICE_NAME = 0x0005;
const FEATURE_UNIFIED_BATTERY = 0x1004;

// Charging, charging slow and complete, as the kernel's hidpp20_unifiedbattery_map_status reads them
const CHARGING_STATUSES = new Set([1, 2, 3]);
const DEVICE_KINDS = new Map([[0, 'keyboard'], [3, 'mouse']]);

const REQUEST_TIMEOUT_SECONDS = 5;

async function tryReadUevent(path, cancellable) {
    try {
        const [contents] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
        return contents;
    } catch {
        return null;
    }
}

async function undrivenReceiverPath(name, cancellable) {
    const devicePath = `/sys/class/hidraw/${name}/device`;

    const contents = await tryReadUevent(`${devicePath}/uevent`, cancellable);
    if (!contents)
        return null;

    const uevent = new TextDecoder().decode(contents);
    const [, bus, vendor, product] = uevent.match(/HID_ID=([0-9A-F]{4}):([0-9A-F]{8}):([0-9A-F]{8})/);
    const productId = parseInt(product, 16);
    if (bus !== BUS_USB || vendor !== LOGITECH_VENDOR_ID
        || productId < RECEIVER_PRODUCT_ID_MIN || productId > RECEIVER_PRODUCT_ID_MAX)
        return null;

    if (!uevent.includes(`DRIVER=${UNDRIVEN_RECEIVER_DRIVER}\n`))
        return null;

    // The HID++ interface has no input node, unlike the keyboard and mouse interfaces
    if (GLib.file_test(`${devicePath}/input`, GLib.FileTest.IS_DIR))
        return null;

    return `/dev/${name}`;
}

async function discoverUndrivenReceivers(cancellable) {
    const dir = Gio.File.new_for_path('/sys/class/hidraw');
    const enumerator = await dir.enumerate_children_async(
        'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    const names = [];
    for await (const info of enumerator)
        names.push(info.get_name());

    const paths = await Promise.all(names.map(name => undrivenReceiverPath(name, cancellable)));
    return paths.filter(path => path);
}

function tryOpenLink(path, logger) {
    try {
        return new HidppReceiverLink(path, logger);
    } catch {
        return null;
    }
}

function isUnpairNotification(data) {
    return data[0] === HIDPP_SHORT_MESSAGE_ID && data[2] === HIDPP_DISCONNECTION_NOTIFICATION
        && data[3] === HIDPP_PERMANENT_DISCONNECTION;
}

function isConnectionNotification(data) {
    return data[0] === HIDPP_SHORT_MESSAGE_ID && data[2] === HIDPP_CONNECTION_NOTIFICATION;
}

// The device-info byte of a connection notification sets this bit while the link is down
function isLinkEstablished(data) {
    return !(data[4] & HIDPP_LINK_STATUS_MASK);
}

function isCharging(statusByte) {
    return CHARGING_STATUSES.has(statusByte);
}

// HID++ devices push battery and status events unsolicited
const HidppReceiverLink = GObject.registerClass({
    Signals: {
        'changed': {},
        'disconnected': {},
    },
}, class HidppReceiverLink extends GObject.Object {
    constructor(path, logger) {
        super();

        const ioStream = Gio.File.new_for_path(path).open_readwrite(null);

        this.path = path;
        this._logger = logger;
        this._ioStream = ioStream;
        this._input = new GioUnix.InputStream({fd: ioStream.get_input_stream().get_fd(), close_fd: false});
        this._output = new GioUnix.OutputStream({fd: ioStream.get_input_stream().get_fd(), close_fd: false});
        this._cancellable = new Gio.Cancellable();
        this._waiters = [];
        this._devices = new Map();
        this._refreshes = new Map();

        this._readLoop();
    }

    close() {
        this._cancellable.cancel();
        this._output.close(null);
        this._ioStream.close(null);

        this._waiters.forEach(waiter => {
            GLib.Source.remove(waiter.timeoutId);
            waiter.reject(new Gio.IOErrorEnum({code: Gio.IOErrorEnum.CANCELLED, message: 'HID++ link closed'}));
        });
        this._waiters = [];
        this._devices.clear();
    }

    getDevices() {
        return Array.from(this._devices.values(), ({kind, percent, charging}) => ({kind, percent, charging, isBluetooth: false}));
    }

    async _readLoop() {
        let bytes;
        try {
            bytes = await this._input.read_bytes_async(32, GLib.PRIORITY_DEFAULT, this._cancellable);
        } catch (e) {
            if (!isCancelled(e)) {
                this.close();
                this.emit('disconnected');
            }
            return;
        }

        this._handleReport(bytes.get_data());
        this._readLoop();
    }

    _handleReport(data) {
        if (isConnectionNotification(data)) {
            if (isLinkEstablished(data)) {
                this._queueRefresh(data[1]);
            } else {
                this._devices.delete(data[1]);
                this.emit('changed');
            }
        }

        if (isUnpairNotification(data)) {
            this._devices.delete(data[1]);
            this.emit('changed');
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
                    reject(new Gio.IOErrorEnum({code: Gio.IOErrorEnum.TIMED_OUT, message: 'HID++ request timed out'}));
                }),
                resolve: reply => {
                    GLib.Source.remove(waiter.timeoutId);
                    resolve(reply);
                },
            };
            this._waiters.push(waiter);
        });
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
        return {percent: reply[4], statusByte: reply[6]};
    }

    async _getDeviceKind(devnumber, featureIndex) {
        const reply = await this._callFeature(devnumber, featureIndex, 2);
        return DEVICE_KINDS.get(reply[4]) ?? 'other';
    }

    // Requests to one device share request IDs, so its refreshes run one after another
    _queueRefresh(devnumber) {
        const previous = this._refreshes.get(devnumber) ?? Promise.resolve();
        this._refreshes.set(devnumber, previous.then(() => this._refreshDevice(devnumber)));
    }

    async _refreshDevice(devnumber) {
        try {
            const batteryFeatureIndex = await this._getFeatureIndex(devnumber, FEATURE_UNIFIED_BATTERY);
            if (!batteryFeatureIndex) {
                this._devices.delete(devnumber);
                return;
            }

            const [nameFeatureIndex, {percent, statusByte}] = await Promise.all([
                this._getFeatureIndex(devnumber, FEATURE_DEVICE_NAME),
                this._getBatteryStatus(devnumber, batteryFeatureIndex),
            ]);
            const kind = nameFeatureIndex ? await this._getDeviceKind(devnumber, nameFeatureIndex) : 'other';

            this._devices.set(devnumber, {kind, batteryFeatureIndex, percent, charging: isCharging(statusByte)});
        } catch (e) {
            // A refresh queued before close() finds the output stream closed
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CLOSED))
                logUnlessCancelled(this._logger, e, `${this.path} devnumber 0x${devnumber.toString(16)} unresponsive`);
            this._devices.delete(devnumber);
        } finally {
            this.emit('changed');
        }
    }

    // Sets one flag and keeps the others, as the kernel's hidpp10_set_register does
    async _enableWirelessNotifications() {
        const reply = await this._request(RECEIVER_DEVNUMBER, (GET_SHORT_REGISTER << 8) | REG_ENABLE_REPORTS);
        const flags = reply.slice(4, 7);
        flags[ENABLE_WIRELESS_NOTIFICATIONS_BYTE] |= ENABLE_WIRELESS_NOTIFICATIONS;
        await this._request(RECEIVER_DEVNUMBER, (SET_SHORT_REGISTER << 8) | REG_ENABLE_REPORTS, flags);
    }

    // The receiver answers with a connection notification per paired device, as hid-logitech-dj does
    async refreshDevices() {
        try {
            await this._enableWirelessNotifications();
            await this._request(RECEIVER_DEVNUMBER, (SET_SHORT_REGISTER << 8) | REG_CONNECTION_STATE, [FAKE_DEVICE_ARRIVAL]);
        } catch (e) {
            logUnlessCancelled(this._logger, e, `refreshDevices on ${this.path} failed`);
        }
    }
});

// Speaks HID++ to receivers the kernel does not drive, reachable through the udev rule in udev/
export const HidppReceiverMonitor = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class HidppReceiverMonitor extends GObject.Object {
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
});
