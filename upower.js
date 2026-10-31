import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {logUnlessCancelled} from './utils.js';

Gio._promisify(Gio.DBusProxy.prototype, 'call');
Gio._promisify(Gio.File.prototype, 'query_info_async');

const UPOWER_BUS_NAME = 'org.freedesktop.UPower';
const UPOWER_OBJECT_PATH = '/org/freedesktop/UPower';
const UPOWER_INTERFACE = 'org.freedesktop.UPower';
const UPOWER_DEVICE_INTERFACE = 'org.freedesktop.UPower.Device';
const BLUEZ_BUS_NAME = 'org.bluez';
const BLUEZ_DEVICE_INTERFACE = 'org.bluez.Device1';

// Power supplies registered by the kernel's hid-logitech-hidpp driver
const HIDPP_BATTERY_PREFIX = 'hidpp_battery_';

// Bluetooth LE batteries reported by BlueZ, whose UPower NativePath is the BlueZ device path
const BLUEZ_DEVICE_PREFIX = '/org/bluez/';
const LOGITECH_MODALIAS = /^\w+:v046Dp/;

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

async function newSystemProxy(busName, objectPath, interfaceName, cancellable) {
    const proxy = new Gio.DBusProxy({
        g_connection: Gio.DBus.system,
        g_name: busName,
        g_object_path: objectPath,
        g_interface_name: interfaceName,
    });
    await proxy.init_async(GLib.PRIORITY_DEFAULT, cancellable);
    // destroy() can run between the finished init and this continuation
    cancellable.set_error_if_cancelled();
    return proxy;
}

// Modalias is optional in BlueZ, e.g. usb:v046DpB369d0016
async function isLogitechBluezDevice(objectPath, cancellable) {
    const proxy = await newSystemProxy(BLUEZ_BUS_NAME, objectPath, BLUEZ_DEVICE_INTERFACE, cancellable);
    const modalias = proxy.get_cached_property('Modalias')?.unpack();
    return LOGITECH_MODALIAS.test(modalias);
}

// UPower hides a wireless device while it is disconnected and adds it back on reconnect
export const UPowerBatteryMonitor = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class UPowerBatteryMonitor extends GObject.Object {
    constructor(logger) {
        super();

        this._logger = logger;
        this._cancellable = new Gio.Cancellable();
        this._devices = new Map();
        this._pendingAdds = new Set();

        this._start();
    }

    destroy() {
        this._cancellable.cancel();

        if (this._upower) {
            this._upower.disconnectObject(this);
            this._upower = null;
        }

        this._devices.forEach(({proxy}) => proxy.disconnectObject(this));
        this._devices.clear();
    }

    getDevices() {
        return Array.from(this._devices, ([path, {proxy, isBluetooth}]) => {
            const state = proxy.get_cached_property('State').unpack();
            return {
                id: path,
                kind: UP_DEVICE_KINDS.get(proxy.get_cached_property('Type').unpack()) ?? 'other',
                percent: Math.round(proxy.get_cached_property('Percentage').unpack()),
                charging: state === UP_DEVICE_STATE_CHARGING || state === UP_DEVICE_STATE_FULLY_CHARGED,
                isBluetooth,
            };
        });
    }

    async _start() {
        try {
            this._upower = await newSystemProxy(UPOWER_BUS_NAME, UPOWER_OBJECT_PATH, UPOWER_INTERFACE, this._cancellable);
            this._upower.connectObject(
                'g-signal::DeviceAdded', (_proxy, _sender, _signal, params) => this._onDeviceAdded(params.deepUnpack()[0]),
                'g-signal::DeviceRemoved', (_proxy, _sender, _signal, params) => this._removeDevice(params.deepUnpack()[0]),
                'notify::g-name-owner', proxy => {
                    if (proxy.get_name_owner())
                        this._enumerateDevices();
                },
                this);
        } catch (e) {
            logUnlessCancelled(this._logger, e, 'UPower connection failed');
            this.emit('changed');
            return;
        }

        this._enumerateDevices();
    }

    async _enumerateDevices() {
        try {
            const reply = await this._upower.call('EnumerateDevices', null, Gio.DBusCallFlags.NONE, -1, this._cancellable);
            const [paths] = reply.deepUnpack();
            await Promise.all(paths.map(path => this._onDeviceAdded(path)));
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
        this._pendingAdds.add(path);

        const proxy = await newSystemProxy(UPOWER_BUS_NAME, path, UPOWER_DEVICE_INTERFACE, this._cancellable);
        // GDBusProxy ignores a failed GetAll, the cache stays empty when the device is already gone
        const nativePath = proxy.get_cached_property('NativePath')?.unpack() ?? '';
        let isBluetooth;
        if (nativePath.startsWith(HIDPP_BATTERY_PREFIX))
            isBluetooth = await isBluetoothSupply(nativePath, this._cancellable);
        else if (nativePath.startsWith(BLUEZ_DEVICE_PREFIX) && await isLogitechBluezDevice(nativePath, this._cancellable))
            isBluetooth = true;
        else
            return;

        // destroy() can run between the finished check and this continuation
        this._cancellable.set_error_if_cancelled();

        // UPower exiting before the handler below is connected leaves an empty cache
        if (!proxy.get_name_owner())
            return;

        // DeviceRemoved can arrive during the awaits above
        if (!this._pendingAdds.delete(path))
            return;

        // UPower adds a known device again after a restart, or while the enumeration is still running
        this._removeDevice(path);

        // UPower exiting empties the property cache
        proxy.connectObject('g-properties-changed', () => {
            if (proxy.get_name_owner())
                this.emit('changed');
            else
                this._removeDevice(path);
        }, this);
        this._devices.set(path, {proxy, isBluetooth});
    }

    _removeDevice(path) {
        this._pendingAdds.delete(path);

        const device = this._devices.get(path);
        if (!device)
            return;

        device.proxy.disconnectObject(this);
        this._devices.delete(path);
        this.emit('changed');
    }
});
