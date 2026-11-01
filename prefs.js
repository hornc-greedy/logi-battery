import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BACKLIGHT_DISPLAY_MODES = ['percentage', 'level', 'bar'];

export default class LogiBatteryPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'dialog-information-symbolic',
        });
        window.add(page);

        window._settings = this.getSettings();

        const batteryGroup = new Adw.PreferencesGroup({
            title: _('Battery'),
        });
        page.add(batteryGroup);

        const batteryIconRow = new Adw.SwitchRow({
            title: _('Show Battery Icon'),
            subtitle: _('Show a battery icon colored by charge level instead of the percentage'),
        });
        batteryGroup.add(batteryIconRow);

        // display-mode and backlight-display-mode hold strings, which Gio.Settings.bind cannot map to these rows
        const syncBatteryIconRow = () => {
            batteryIconRow.active = window._settings.get_string('display-mode') === 'icon';
        };
        const displayModeChangedId = window._settings.connect('changed::display-mode', syncBatteryIconRow);
        syncBatteryIconRow();
        batteryIconRow.connect('notify::active', () =>
            window._settings.set_string('display-mode', batteryIconRow.active ? 'icon' : 'percentage'));

        const backlightGroup = new Adw.PreferencesGroup({
            title: _('Keyboard Brightness'),
            description: _('Available for keyboards connected through a Bolt receiver, which needs the udev rule from the repository'),
        });
        page.add(backlightGroup);

        const showBacklightRow = new Adw.SwitchRow({
            title: _('Show in Top Bar'),
            subtitle: _('Show the keyboard brightness next to the keyboard battery'),
        });
        backlightGroup.add(showBacklightRow);
        window._settings.bind('show-backlight', showBacklightRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const displayModeRow = new Adw.ComboRow({
            title: _('Display'),
            model: Gtk.StringList.new([_('Percentage'), _('Level'), _('Bar')]),
        });
        backlightGroup.add(displayModeRow);
        showBacklightRow.bind_property('active', displayModeRow, 'sensitive', GObject.BindingFlags.SYNC_CREATE);

        const syncDisplayModeRow = () => {
            displayModeRow.selected = BACKLIGHT_DISPLAY_MODES.indexOf(window._settings.get_string('backlight-display-mode'));
        };
        const backlightDisplayModeChangedId = window._settings.connect('changed::backlight-display-mode', syncDisplayModeRow);
        syncDisplayModeRow();
        displayModeRow.connect('notify::selected', () =>
            window._settings.set_string('backlight-display-mode', BACKLIGHT_DISPLAY_MODES[displayModeRow.selected]));

        window.connect('close-request', () => {
            window._settings.disconnect(displayModeChangedId);
            window._settings.disconnect(backlightDisplayModeChangedId);
        });
    }
}
