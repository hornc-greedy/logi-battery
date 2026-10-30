import Gio from 'gi://Gio';

export function isCancelled(error) {
    return error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// A cancelled operation is the extension being disabled or the receiver being gone, not a failure
export function logUnlessCancelled(logger, error, message) {
    if (!isCancelled(error))
        logger.warn(`${message}: ${error.message}`);
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
