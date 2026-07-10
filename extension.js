import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';

import {
    discoverHidppInterfaces, watchHidrawDirectory, HidppLink,
    deviceKindIconName, batteryLevel, batteryLevelIconName, batteryLevelColor,
} from './utils.js';

function makeStatusIcon(iconName) {
    return new St.Icon({ icon_name: iconName, style_class: 'system-status-icon' });
}

function tryOpenLink(path, isReceiver) {
    try {
        return new HidppLink(path, { isReceiver });
    } catch {
        return null;
    }
}

class Indicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor(extension) {
        super(0.5, extension.metadata.name);

        this._settings = extension.getSettings();
        this._cancellable = new Gio.Cancellable();
        this._view = null;
        this._hidppLinks = [];

        this._box = new St.BoxLayout({ style_class: 'logi-battery-box' });
        this.add_child(this._box);

        this._buildMenu();

        this._settings.connectObject('changed::display-mode', () => {
            if (this._view === 'devices')
                this._renderDevices(this._getAllDevices());
        }, this);
        this.connect('destroy', () => this._onDestroy());

        this._connectHidpp().then(() => this._refresh());
        try {
            this._hidrawMonitor = watchHidrawDirectory(() => {
                this._connectHidpp().then(connected => {
                    if (connected)
                        this._refresh();
                });
            });
        } catch (e) {
            console.error(`logi-battery: watchHidrawDirectory failed: ${e.message}`);
        }

        this._setView('loading');
    }

    async _connectHidpp() {
        let interfaces;
        try {
            interfaces = await discoverHidppInterfaces(this._cancellable);
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                console.error(`logi-battery: discoverHidppInterfaces failed: ${e.message}`);
            return false;
        }

        if (this._cancellable.is_cancelled())
            return false;

        const knownPaths = new Set(this._hidppLinks.map(link => link.path));
        let connectedAny = false;

        for (const { path, isReceiver } of interfaces) {
            if (knownPaths.has(path))
                continue;

            const link = tryOpenLink(path, isReceiver);
            if (!link)
                continue;

            link.onChange = () => this._render();
            link.onDisconnect = () => {
                link.close();
                this._hidppLinks = this._hidppLinks.filter(l => l !== link);
                this._render();
            };
            this._hidppLinks.push(link);
            connectedAny = true;
        }

        return connectedAny;
    }

    async _refresh() {
        if (this._cancellable.is_cancelled())
            return;
        if (this._hidppLinks.length)
            await Promise.all(this._hidppLinks.map(link => link.refreshDevices()));
        else
            this._render();
    }

    _getAllDevices() {
        return this._hidppLinks.flatMap(link => link.getDevices());
    }

    _render() {
        if (this._cancellable.is_cancelled())
            return;
        const devices = this._getAllDevices();
        this._setView(devices.length ? 'devices' : 'nodevices', devices);
    }

    _buildMenu() {
        const showIcon = this._settings.get_string('display-mode') === 'icon';
        this._displaySwitch = new PopupMenu.PopupSwitchMenuItem('Show battery icon', showIcon);
        this._displaySwitch.connectObject('toggled', (item, state) => {
            this._settings.set_string('display-mode', state ? 'icon' : 'percentage');
        }, this);
        this.menu.addMenuItem(this._displaySwitch);
    }

    _setView(view, devices) {
        if (this._view === view && view !== 'devices')
            return;
        this._view = view;
        if (view === 'loading')
            this._renderLoading();
        else if (view === 'nodevices')
            this._renderMessage('No devices found');
        else if (view === 'devices')
            this._renderDevices(devices);
    }

    _renderDevices(devices) {
        const showIcon = this._settings.get_string('display-mode') === 'icon';
        this._box.destroy_all_children();

        devices.forEach((device, index) => {
            if (index > 0) {
                this._box.add_child(new St.Label({
                    text: '|',
                    style_class: 'logi-battery-separator',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            const row = new St.BoxLayout({ style_class: 'logi-battery-device' });

            const iconGroup = new St.BoxLayout({ style_class: 'logi-battery-icon-group' });
            iconGroup.add_child(makeStatusIcon(deviceKindIconName(device.kind)));
            if (device.isBluetooth)
                iconGroup.add_child(makeStatusIcon('bluetooth-active-symbolic'));
            row.add_child(iconGroup);

            const level = batteryLevel(device.percent);

            if (showIcon) {
                const batteryIcon = makeStatusIcon(batteryLevelIconName(level, device.charging));
                batteryIcon.set_style(`color: ${batteryLevelColor(level)};`);
                row.add_child(batteryIcon);
            } else {
                row.add_child(new St.Label({
                    text: `${device.percent}%`,
                    y_align: Clutter.ActorAlign.CENTER,
                }));

                if (device.charging)
                    row.add_child(makeStatusIcon(batteryLevelIconName(level, true)));
            }

            this._box.add_child(row);
        });
    }

    _renderLoading() {
        this._box.destroy_all_children();
        const spinner = new Animation.Spinner(16, { animate: true });
        this._box.add_child(spinner);
        spinner.play();
    }

    _renderMessage(text) {
        this._box.destroy_all_children();
        this._box.add_child(new St.Label({ text, y_align: Clutter.ActorAlign.CENTER }));
    }

    _onDestroy() {
        this._cancellable.cancel();

        this._hidppLinks.forEach(link => link.close());
        this._hidppLinks = [];
        this._hidrawMonitor?.cancel();

        this._settings.disconnectObject(this);
        this._displaySwitch.disconnectObject(this);
    }
}

export default class LogiBatteryExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
