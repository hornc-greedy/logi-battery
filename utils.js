import Gio from 'gi://Gio';

// A cancelled operation is the extension being disabled, not a failure
export function logUnlessCancelled(error, message) {
    if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        console.warn(`logi-battery: ${message}: ${error.message}`);
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
