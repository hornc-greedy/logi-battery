import Adw from 'gi://Adw';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

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

        // display-mode holds a string, which Gio.Settings.bind cannot map to this row
        const syncBatteryIconRow = () => {
            batteryIconRow.active = window._settings.get_string('display-mode') === 'icon';
        };
        const displayModeChangedId = window._settings.connect('changed::display-mode', syncBatteryIconRow);
        syncBatteryIconRow();
        batteryIconRow.connect('notify::active', () =>
            window._settings.set_string('display-mode', batteryIconRow.active ? 'icon' : 'percentage'));

        window.connect('close-request', () => {
            window._settings.disconnect(displayModeChangedId);
        });
    }
}
