export function isNotificationSupported(): boolean {
    if (typeof window === "undefined" || !("Notification" in window)) {
        return false;
    }
    // Chrome on Android exposes the Notification API but `new Notification()`
    // throws ("Illegal constructor"); notifications there require a service
    // worker via ServiceWorkerRegistration.showNotification(). This app has
    // no service worker, so report notifications as unsupported on Android
    // instead of telling users notifications are enabled when none can be shown.
    if (typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")) {
        return false;
    }
    return true;
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

export function sendBrowserNotification(title: string, options?: NotificationOptions): boolean {
    if (!isNotificationSupported() || Notification.permission !== "granted") {
        return false;
    }
    try {
        const notification = new Notification(title, options);
        notification.onclick = () => {
            window.focus();
            notification.close();
        };
        return true;
    } catch {
        return false;
    }
}
