import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { logUnlessCancelled } from './utils.js';

Gio._promisify(Gio.DBusProxy.prototype, 'call', 'call_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');

const UPOWER_BUS_NAME = 'org.freedesktop.UPower';
const UPOWER_OBJECT_PATH = '/org/freedesktop/UPower';
const UPOWER_INTERFACE = 'org.freedesktop.UPower';
const UPOWER_DEVICE_INTERFACE = 'org.freedesktop.UPower.Device';

// Power supplies registered by the kernel's hid-logitech-hidpp driver
const HIDPP_BATTERY_PREFIX = 'hidpp_battery_';

const BUS_BLUETOOTH = '0005';

const UP_DEVICE_KINDS = new Map([[5, 'mouse'], [6, 'keyboard']]);

const UP_DEVICE_STATE_CHARGING = 1;
const UP_DEVICE_STATE_FULLY_CHARGED = 4;

// The supply's parent HID device is named after its bus, e.g. 0005:046D:B034.0004
async function isBluetoothSupply(nativePath, cancellable) {
    const info = await Gio.File.new_for_path(`/sys/class/power_supply/${nativePath}/device`).query_info_async(
        'standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, cancellable);
    return GLib.path_get_basename(info.get_symlink_target()).startsWith(`${BUS_BLUETOOTH}:`);
}

async function newUPowerProxy(objectPath, interfaceName, cancellable) {
    const proxy = new Gio.DBusProxy({
        g_connection: Gio.DBus.system,
        g_name: UPOWER_BUS_NAME,
        g_object_path: objectPath,
        g_interface_name: interfaceName,
    });
    await proxy.init_async(GLib.PRIORITY_DEFAULT, cancellable);
    return proxy;
}

// UPower hides a wireless device while it is disconnected and adds it back on reconnect
export class UPowerBatteryMonitor extends GObject.Object {
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
        this._devices = new Map();

        this._start();
    }

    destroy() {
        this._cancellable.cancel();

        if (this._upower)
            this._upower.disconnectObject(this);

        this._devices.forEach(({ proxy }) => proxy.disconnectObject(this));
        this._devices.clear();
    }

    getDevices() {
        return Array.from(this._devices.values(), ({ proxy, isBluetooth }) => {
            const state = proxy.get_cached_property('State').unpack();
            return {
                kind: UP_DEVICE_KINDS.get(proxy.get_cached_property('Type').unpack()) ?? 'other',
                percent: Math.round(proxy.get_cached_property('Percentage').unpack()),
                charging: state === UP_DEVICE_STATE_CHARGING || state === UP_DEVICE_STATE_FULLY_CHARGED,
                isBluetooth,
            };
        });
    }

    async _start() {
        try {
            this._upower = await newUPowerProxy(UPOWER_OBJECT_PATH, UPOWER_INTERFACE, this._cancellable);
            this._upower.connectObject(
                'g-signal::DeviceAdded', (_proxy, _sender, _signal, params) => this._onDeviceAdded(params.deepUnpack()[0]),
                'g-signal::DeviceRemoved', (_proxy, _sender, _signal, params) => this._removeDevice(params.deepUnpack()[0]),
                this);

            const reply = await this._upower.call('EnumerateDevices', null, Gio.DBusCallFlags.NONE, -1, this._cancellable);
            const [paths] = reply.deepUnpack();
            await Promise.all(paths.map(path => this._addDevice(path)));
        } catch (e) {
            logUnlessCancelled(this._logger, e, 'UPower enumeration failed');
        }
        this.emit('changed');
    }

    async _onDeviceAdded(path) {
        try {
            await this._addDevice(path);
        } catch (e) {
            logUnlessCancelled(this._logger, e, `${path} failed`);
        }
        this.emit('changed');
    }

    async _addDevice(path) {
        const proxy = await newUPowerProxy(path, UPOWER_DEVICE_INTERFACE, this._cancellable);
        const nativePath = proxy.get_cached_property('NativePath').unpack();
        const type = proxy.get_cached_property('Type').unpack();
        const model = proxy.get_cached_property('Model').unpack();
        const bluetoothKeyboard = nativePath.startsWith('/org/bluez/')
            && type === 6 && model.toUpperCase().includes('MX KEYS');
        if (!nativePath.startsWith(HIDPP_BATTERY_PREFIX) && !bluetoothKeyboard)
            return;

        const isBluetooth = bluetoothKeyboard ||
            await isBluetoothSupply(nativePath, this._cancellable);

        proxy.connectObject('g-properties-changed', () => this.emit('changed'), this);
        this._devices.set(path, { proxy, isBluetooth });
    }

    _removeDevice(path) {
        const device = this._devices.get(path);
        if (!device)
            return;

        device.proxy.disconnectObject(this);
        this._devices.delete(path);
        this.emit('changed');
    }
}
