export function isNotificationSupported(): boolean {
    return typeof window !== "undefined" && "Notification" in window;
}

export function getNotificationPermission(): NotificationPermission | "unsupported" {
    if (!isNotificationSupported()) {
        return "unsupported";
    }
    return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
    if (!isNotificationSupported()) {
        return "unsupported";
    }
    if (Notification.permission === "granted" || Notification.permission === "denied") {
        return Notification.permission;
    }
    try {
        return await Notification.requestPermission();
    } catch {
        return Notification.permission;
    }
}

export function sendBrowserNotification(title: string, options?: NotificationOptions): void {
    if (!isNotificationSupported() || Notification.permission !== "granted") {
        return;
    }
    try {
        const notification = new Notification(title, options);
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
    } catch {
        return;
    }
}
