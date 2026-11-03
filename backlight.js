import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {backlightFraction, backlightIconName} from './utils.js';

// Port of GNOME Shell's js/ui/status/backlight.js, with the HID++ monitor in place of the gsd-power proxy

// Slider's marks only catch values close to them, the backlight has nothing between its levels
const LevelSlider = GObject.registerClass(
class LevelSlider extends Slider {
    _snapToMark(value) {
        const maxLevel = this.nLevels - 1;
        return Math.round(value * maxLevel) / maxLevel;
    }

    // Slider.step() moves a fiftieth of the range, one wheel notch or arrow press here moves one level
    step(nSteps) {
        return super.step(nSteps * 50 / (this.nLevels - 1));
    }
});

const SliderItem = GObject.registerClass({
    Properties: {
        'value': GObject.ParamSpec.int(
            'value', null, null,
            GObject.ParamFlags.READWRITE,
            0, 100, 0),
    },
}, class SliderItem extends PopupMenu.PopupBaseMenuItem {
    constructor() {
        super({
            activate: false,
            style_class: 'keyboard-brightness-item',
        });

        this._slider = new LevelSlider(0);

        this._slider.connect('notify::value', () => this.notify('value'));
        this._slider.accessible_name = _('Keyboard Brightness');

        this.add_child(this._slider);
    }

    get nLevels() {
        return this._slider.nLevels;
    }

    set nLevels(nLevels) {
        this._slider.nLevels = nLevels;
    }

    get value() {
        return this._slider.value * 100;
    }

    set value(value) {
        // The next wheel or arrow step starts from this level, not from the last drag position
        this._slider._unsnappedValue = null;
        this._slider.value = value / 100;
    }

    // The arrow keys go through LevelSlider.step() to move one level
    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Left || key === Clutter.KEY_Right) {
            const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
            const increaseKey = rtl ? Clutter.KEY_Left : Clutter.KEY_Right;
            this._slider.step(key === increaseKey ? 1 : -1);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});

const KeyboardBrightnessToggle = GObject.registerClass(
class KeyboardBrightnessToggle extends QuickMenuToggle {
    constructor(extension, monitor) {
        super({
            title: _('Keyboard'),
            iconName: 'keyboard-brightness-symbolic',
            menuButtonAccessibleName: _('Open keyboard brightness menu'),
        });

        this.menu.setHeader('keyboard-brightness-symbolic', _('Keyboard Brightness'));

        this._settings = extension.getSettings();
        this._monitor = monitor;
        this._monitor.connectObject('changed', () => this._sync(), this);

        // The screen lock disables the extension, so the brightness to restore lives in GSettings, and it can round to 0 on a keyboard with fewer levels
        this.connect('clicked', () => {
            const {backlight} = this._findBacklightDevice();
            const level = Math.round(this._settings.get_int('last-backlight-brightness') / 100 * (backlight.steps - 1));
            backlight.setLevel(this.checked ? 0 : Math.max(level, 1));
        });

        this._sliderItem = new SliderItem();
        this.menu.box.add_child(this._sliderItem);
        const sliderAccessible = this._sliderItem._slider.get_accessible();
        sliderAccessible.set_parent(this.menu.box.get_accessible());
        this._sliderItem.set_accessible(sliderAccessible);

        this._sliderItemChangedId = this._sliderItem.connect('notify::value', () =>
            this._setBrightness(this._sliderItem.value));

        this._sync();
    }

    // Quick settings keep the menu in their own overlay, outside this tile
    destroy() {
        this._monitor.disconnectObject(this);
        this._monitor = null;
        this._settings = null;
        this._sliderItem.disconnect(this._sliderItemChangedId);
        this._sliderItem.destroy();
        this._sliderItem = null;
        this.menu.destroy();
        super.destroy();
    }

    _findBacklightDevice() {
        return this._monitor.getDevices().find(device => device.backlight);
    }

    // HID++ sets whole levels where gsd-power takes a percentage, and the menu can stay open after the keyboard is gone
    _setBrightness(value) {
        const backlight = this._findBacklightDevice()?.backlight;
        if (!backlight)
            return;

        backlight.setLevel(Math.round(value / 100 * (backlight.steps - 1)));
    }

    _sync() {
        const device = this._findBacklightDevice();
        const visible = Boolean(device);
        this.visible = visible;
        if (!visible)
            return;

        this.subtitle = device.name;

        const {backlight} = device;

        const brightness = Math.round(backlightFraction(backlight) * 100);
        this.checked = brightness > 0;
        this.iconName = backlightIconName(backlight);
        // Off and on need only the tile
        this.menuEnabled = backlight.steps > 2;
        // Battery changes land here too, and only a new brightness is worth a dconf write
        if (this.checked && backlight.steps > 2 && brightness !== this._settings.get_int('last-backlight-brightness'))
            this._settings.set_int('last-backlight-brightness', brightness);

        this._sliderItem.block_signal_handler(this._sliderItemChangedId);
        this._sliderItem.set({
            nLevels: backlight.steps,
            value: brightness,
        });
        this._sliderItem.unblock_signal_handler(this._sliderItemChangedId);
    }
});

export const Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    constructor(extension, monitor) {
        super();

        this.quickSettingsItems.push(new KeyboardBrightnessToggle(extension, monitor));
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});
