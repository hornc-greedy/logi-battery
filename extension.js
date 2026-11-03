import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';
import {BarLevel} from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as BacklightStatus from './backlight.js';
import {HidppReceiverMonitor} from './hidpp.js';
import {UPowerBatteryMonitor} from './upower.js';
import {deviceKindIconName, batteryLevel, batteryLevelIconName, backlightFraction, backlightIconName} from './utils.js';

const percentFormatter = new Intl.NumberFormat(undefined, {style: 'percent'});

function makeStatusIcon(iconName) {
    return new St.Icon({icon_name: iconName, style_class: 'system-status-icon'});
}

// Long-lived per device, updated in place like the indicators in GNOME Shell's js/ui/status/
const DeviceItem = GObject.registerClass(
class DeviceItem extends St.BoxLayout {
    constructor() {
        super({style_class: 'logi-battery-device'});

        this.separator = new St.Widget({style_class: 'logi-battery-separator'});
        this.add_child(this.separator);

        const iconGroup = new St.BoxLayout();
        this._kindIcon = makeStatusIcon(null);
        this._bluetoothIcon = makeStatusIcon('bluetooth-active-symbolic');
        iconGroup.add_child(this._kindIcon);
        iconGroup.add_child(this._bluetoothIcon);
        this.add_child(iconGroup);

        this._batteryIcon = makeStatusIcon(null);
        this._percentageLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._chargingIcon = makeStatusIcon(null);
        this.add_child(this._batteryIcon);
        this.add_child(this._percentageLabel);
        this.add_child(this._chargingIcon);

        this._backlightIcon = makeStatusIcon(null);
        this._backlightLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this._backlightBar = new BarLevel({
            style_class: 'logi-battery-backlight-bar',
            accessible_name: _('Keyboard Brightness'),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._backlightIcon);
        this.add_child(this._backlightLabel);
        this.add_child(this._backlightBar);
    }

    update(device, showIcon, backlightDisplayMode) {
        const level = batteryLevel(device.percent);

        this._kindIcon.icon_name = deviceKindIconName(device.kind);
        this._bluetoothIcon.visible = device.isBluetooth;

        this._batteryIcon.set({
            icon_name: batteryLevelIconName(level, device.charging),
            style_class: `system-status-icon logi-battery-${level}`,
            visible: showIcon,
        });
        this._percentageLabel.set({
            text: percentFormatter.format(device.percent / 100),
            visible: !showIcon,
        });
        this._chargingIcon.set({
            icon_name: batteryLevelIconName(level, true),
            visible: !showIcon && device.charging,
        });

        const {backlight} = device;
        const showBacklight = Boolean(backlight && backlightDisplayMode);
        const backlightOn = showBacklight && backlight.level > 0;
        this._backlightIcon.visible = showBacklight;
        // Off and on need only the icon
        const showLevel = backlightOn && backlight.steps > 2;
        this._backlightLabel.visible = showLevel && backlightDisplayMode !== 'bar';
        this._backlightBar.visible = showLevel && backlightDisplayMode === 'bar';
        if (!showBacklight)
            return;

        const fraction = backlightFraction(backlight);
        this._backlightIcon.icon_name = backlightIconName(backlight);
        this._backlightLabel.text = backlightDisplayMode === 'level'
            ? `${backlight.level}`
            : percentFormatter.format(fraction);
        this._backlightBar.value = fraction;
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    constructor(extension, monitors) {
        super(0.5, extension.metadata.name);

        this._settings = extension.getSettings();
        this._monitors = monitors;
        this._deviceItems = new Map();

        this._box = new St.BoxLayout({style_class: 'logi-battery-box'});
        this.add_child(this._box);

        this._spinner = new Animation.Spinner(16, {animate: true, hideOnStop: true});
        this._box.add_child(this._spinner);
        this._spinner.play();

        this._message = new St.Label({
            text: _('No devices found'),
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._box.add_child(this._message);

        this._settings.connectObject(
            'changed::display-mode', () => this._sync(),
            'changed::show-backlight', () => this._sync(),
            'changed::backlight-display-mode', () => this._sync(),
            this);
        this._monitors.forEach(monitor => monitor.connectObject('changed', () => this._sync(), this));

        this.menu.addAction(_('Preferences'), () => extension.openPreferences());
    }

    _sync() {
        const devices = this._monitors.flatMap(monitor => monitor.getDevices());
        const showIcon = this._settings.get_string('display-mode') === 'icon';
        const backlightDisplayMode = this._settings.get_boolean('show-backlight')
            ? this._settings.get_string('backlight-display-mode')
            : null;
        const ids = new Set(devices.map(device => device.id));

        this._deviceItems.forEach((item, id) => {
            if (!ids.has(id)) {
                item.destroy();
                this._deviceItems.delete(id);
            }
        });

        devices.forEach((device, index) => {
            if (!this._deviceItems.has(device.id)) {
                const item = new DeviceItem();
                this._deviceItems.set(device.id, item);
                this._box.add_child(item);
            }

            const item = this._deviceItems.get(device.id);
            item.update(device, showIcon, backlightDisplayMode);
            item.separator.visible = index > 0;
            // The spinner and the message come first
            this._box.set_child_at_index(item, index + 2);
        });

        this._spinner.stop();
        this._message.visible = devices.length === 0;
    }

    destroy() {
        this._monitors.forEach(monitor => monitor.disconnectObject(this));
        this._settings.disconnectObject(this);
        this._settings = null;
        this._monitors = null;
        this._deviceItems.clear();

        super.destroy();
    }
});

export default class LogiBatteryExtension extends Extension {
    enable() {
        const logger = this.getLogger();
        this._upowerMonitor = new UPowerBatteryMonitor(logger);
        this._hidppMonitor = new HidppReceiverMonitor(logger);

        this._indicator = new Indicator(this, [this._upowerMonitor, this._hidppMonitor]);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._backlightIndicator = new BacklightStatus.Indicator(this, this._hidppMonitor);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._backlightIndicator);
    }

    disable() {
        this._backlightIndicator.destroy();
        this._backlightIndicator = null;
        this._indicator.destroy();
        this._indicator = null;

        this._hidppMonitor.destroy();
        this._hidppMonitor = null;
        this._upowerMonitor.destroy();
        this._upowerMonitor = null;
    }
}
