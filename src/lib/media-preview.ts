export function createExpandButton(media: HTMLElement, label: string, expand: () => void): HTMLButtonElement {
    const button = media.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "dgl-media-expand";
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-label", label);
    button.disabled = true;
    button.appendChild(media);
    button.addEventListener("click", expand);
    return button;
}

type PlaybackOptions = { expand: HTMLButtonElement } | { picture: HTMLButtonElement };

const icons = {
    play: '<path fill="currentColor" stroke="none" d="M8 5v14l11-7z"/>',
    pause: '<path fill="currentColor" stroke="none" d="M7 5h3.5v14H7zm6.5 0H17v14h-3.5z"/>',
    expand: '<path d="M9 4H4v5m11-5h5v5m-5 11h5v-5M9 20H4v-5"/>',
    shrink: '<path d="M4 9h5V4m11 5h-5V4m5 11h-5v5M4 15h5v5"/>',
    volume: '<path d="M11 5 6 9H3v6h3l5 4zm4 4a4 4 0 0 1 0 6m2-9a8 8 0 0 1 0 12"/>',
    mute: '<path d="M11 5 6 9H3v6h3l5 4zm5 4 5 6m0-6-5 6"/>',
};

function setButton(button: HTMLButtonElement, label: string, icon: keyof typeof icons): void {
    button.setAttribute("aria-label", label);
    button.title = label;
    if (button.dataset.icon === icon) return;
    button.dataset.icon = icon;
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[icon]}</svg>`;
}

function formatTime(seconds: number, precise = false): string {
    const tenths = Math.floor(seconds * 10);
    const wholeSeconds = Math.floor(tenths / 10);
    const minutes = Math.floor(wholeSeconds / 60);
    const time = `${minutes}:${String(wholeSeconds % 60).padStart(2, "0")}`;
    return precise ? `${time}.${tenths % 10}` : time;
}

export function createPlaybackPicture(media: HTMLVideoElement | HTMLImageElement): HTMLButtonElement {
    const picture = media.ownerDocument.createElement("button");
    picture.type = "button";
    picture.className = "dgl-playback-picture";
    picture.disabled = true;
    media.draggable = false;
    picture.appendChild(media);
    return picture;
}

export function createPlaybackControls(player: HTMLElement, options: PlaybackOptions) {
    const document = player.ownerDocument;
    const events = new AbortController();
    const listen = { signal: events.signal };
    const controls = player.appendChild(document.createElement("div"));
    controls.className = "dgl-playback-controls";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.disabled = true;
    const seek = document.createElement("input");
    seek.type = "range";
    seek.className = "dgl-playback-seek";
    seek.max = seek.min = seek.value = "0";
    seek.disabled = true;
    seek.setAttribute("aria-label", "Playback position");

    const expanded = "picture" in options ? options : undefined;
    let volumeHost = controls;
    let volumeBefore: HTMLElement | null = null;
    let time: HTMLElement | undefined;
    let expand: HTMLButtonElement | undefined;
    let unitsPerSecond = 1;
    let durationSeconds = 0;
    let playing = false;
    let hideTimer = 0;
    let scrubPointer: number | undefined;
    let resumeAfterScrub = false;

    function showControls(): void {
        window.clearTimeout(hideTimer);
        player.classList.remove("dgl-controls-idle");
        if (!playing) return;
        hideTimer = window.setTimeout(() => {
            if (scrubPointer === undefined && !controls.matches(":hover, :has(:focus-visible)")) {
                player.classList.add("dgl-controls-idle");
            }
        }, 2000);
    }

    if (expanded) {
        player.classList.add("dgl-expanded-player");
        const timeline = controls.appendChild(document.createElement("div"));
        timeline.className = "dgl-playback-timeline";
        timeline.appendChild(seek);
        const hint = timeline.appendChild(document.createElement("span"));
        hint.className = "dgl-playback-hint";
        hint.hidden = true;
        hint.setAttribute("aria-hidden", "true");
        const row = controls.appendChild(document.createElement("div"));
        row.className = "dgl-playback-row";
        row.appendChild(toggle);
        time = row.appendChild(document.createElement("span"));
        time.className = "dgl-playback-time";
        volumeHost = row;
        if (document.fullscreenEnabled) volumeBefore = addFullscreenControl(row, player, listen);

        expanded.picture.addEventListener("click", () => toggle.click(), listen);
        for (const name of ["pointermove", "pointerdown", "focusin", "focusout"] as const) {
            player.addEventListener(name, showControls, listen);
        }
        controls.addEventListener("pointerleave", showControls, listen);

        function showTargetTime(event: PointerEvent): void {
            if (seek.disabled || (event.pointerType === "touch" && scrubPointer === undefined)) return;
            const bounds = seek.getBoundingClientRect();
            const thumbRadius = 6;
            const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left - thumbRadius) / Math.max(1, bounds.width - 2 * thumbRadius)));
            const target = fraction * Number(seek.max);
            const position = seek.step === "any" ? target : Math.round(target);
            hint.textContent = formatTime(position / unitsPerSecond, true);
            hint.style.left = `${fraction * 100}%`;
            hint.hidden = false;
        }

        seek.addEventListener("pointermove", showTargetTime, listen);
        seek.addEventListener("pointerleave", () => { hint.hidden = true; }, listen);
        seek.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || scrubPointer !== undefined) return;
            scrubPointer = event.pointerId;
            resumeAfterScrub = playing;
            if (resumeAfterScrub) toggle.click();
            showTargetTime(event);
        }, listen);
        function endScrub(event: PointerEvent): void {
            if (event.pointerId !== scrubPointer) return;
            scrubPointer = undefined;
            hint.hidden = true;
            if (resumeAfterScrub) toggle.click();
            showControls();
        }
        document.addEventListener("pointerup", endScrub, { ...listen, capture: true });
        document.addEventListener("pointercancel", endScrub, { ...listen, capture: true });
    } else if ("expand" in options) {
        controls.append(toggle, seek);
        expand = controls.appendChild(document.createElement("button"));
        volumeBefore = expand;
        expand.type = "button";
        expand.disabled = true;
        const pictureExpand = options.expand;
        setButton(expand, pictureExpand.getAttribute("aria-label") ?? "Expand video", "expand");
        expand.setAttribute("aria-haspopup", "dialog");
        expand.addEventListener("click", () => pictureExpand.click(), listen);
    }

    function enablePlay(): void {
        toggle.disabled = false;
        const picture = "picture" in options ? options.picture : options.expand;
        picture.disabled = false;
        if (expand) expand.disabled = false;
    }

    function setPlaying(value: boolean): void {
        playing = value;
        const label = playing ? "Pause video" : "Play video";
        setButton(toggle, label, playing ? "pause" : "play");
        if (expanded) {
            expanded.picture.setAttribute("aria-label", label);
            showControls();
        }
    }

    function setDuration(max: number, units = 1, duration = max / units): void {
        unitsPerSecond = units;
        durationSeconds = Number.isFinite(duration) && duration > 0 ? duration : 0;
        seek.max = String(Number.isFinite(max) && max > 0 ? max : 0);
        seek.disabled = Number(seek.max) === 0;
        setPosition(seek.valueAsNumber);
    }

    function setPosition(position: number): void {
        seek.value = String(position);
        const max = Number(seek.max);
        seek.style.setProperty("--playback-position", `${max > 0 ? seek.valueAsNumber / max * 100 : 0}%`);
        if (time) {
            const current = formatTime(seek.valueAsNumber / unitsPerSecond);
            const duration = formatTime(durationSeconds);
            const display = `${current} / ${duration}`;
            if (time.textContent !== display) time.textContent = display;
            seek.setAttribute("aria-valuetext", `${formatTime(seek.valueAsNumber / unitsPerSecond, true)} of ${duration}`);
        }
    }

    setPlaying(false);
    setPosition(0);
    function destroy(): void {
        events.abort();
        window.clearTimeout(hideTimer);
    }

    function addAudio(audio: HTMLMediaElement): void {
        controls.classList.add("dgl-playback-controls--audio");
        addVolumeControls(volumeHost, volumeBefore, audio, events.signal);
    }

    return { toggle, seek, enablePlay, setPlaying, setDuration, setPosition, addAudio, destroy };
}

const previewAudio = new Set<HTMLMediaElement>();
let previewVolume = 1;
let previewMuted = false;

function setPreviewVolume(level: number, muted: boolean): void {
    previewVolume = level;
    previewMuted = muted;
    for (const audio of previewAudio) {
        audio.volume = level;
        audio.muted = muted;
    }
}

function addVolumeControls(row: HTMLElement, before: HTMLElement | null, audio: HTMLMediaElement, signal: AbortSignal): void {
    const listen = { signal };
    const volume = row.insertBefore(row.ownerDocument.createElement("div"), before);
    volume.className = "dgl-playback-volume";
    const mute = volume.appendChild(row.ownerDocument.createElement("button"));
    mute.type = "button";
    const slider = volume.appendChild(row.ownerDocument.createElement("input"));
    slider.type = "range";
    slider.min = "0";
    slider.max = "1";
    slider.step = "0.05";
    slider.setAttribute("aria-label", "Volume");

    function update(): void {
        const silent = audio.muted || audio.volume === 0;
        setButton(mute, silent ? "Unmute" : "Mute", silent ? "mute" : "volume");
        slider.value = String(silent ? 0 : audio.volume);
        slider.style.setProperty("--playback-position", `${slider.valueAsNumber * 100}%`);
    }
    mute.addEventListener("click", () => {
        setPreviewVolume(audio.volume || 1, audio.volume > 0 && !audio.muted);
    }, listen);
    slider.addEventListener("input", () => {
        setPreviewVolume(slider.valueAsNumber, false);
    }, listen);
    audio.addEventListener("volumechange", update, listen);
    audio.volume = previewVolume;
    audio.muted = previewMuted;
    previewAudio.add(audio);
    signal.addEventListener("abort", () => previewAudio.delete(audio), { once: true });
    update();
}

function addFullscreenControl(row: HTMLElement, player: HTMLElement, listen: AddEventListenerOptions): HTMLButtonElement {
    const document = row.ownerDocument;
    const fullscreen = row.appendChild(document.createElement("button"));
    fullscreen.type = "button";
    function update(): void {
        const active = document.fullscreenElement === player;
        setButton(fullscreen, active ? "Exit fullscreen" : "Fullscreen", active ? "shrink" : "expand");
    }
    fullscreen.addEventListener("click", () => {
        const request = document.fullscreenElement === player ? document.exitFullscreen() : player.requestFullscreen();
        void request.catch(() => {});
    }, listen);
    document.addEventListener("fullscreenchange", update, listen);
    update();
    return fullscreen;
}

export function connectNativePlayback(player: HTMLElement, video: HTMLVideoElement, options: PlaybackOptions, startTime = 0): () => void {
    const controls = createPlaybackControls(player, options);
    controls.addAudio(video);
    const { toggle, seek, enablePlay, setPlaying, setDuration, setPosition } = controls;
    const events = new AbortController();
    const listen = { signal: events.signal };
    seek.step = "any";

    video.addEventListener("loadedmetadata", () => {
        if (startTime > 0) video.currentTime = Math.min(startTime, video.duration);
        enablePlay();
    }, listen);
    video.addEventListener("durationchange", () => {
        setDuration(video.duration);
        setPosition(video.currentTime);
    }, listen);
    video.addEventListener("timeupdate", () => setPosition(video.currentTime), listen);
    video.addEventListener("play", () => setPlaying(true), listen);
    video.addEventListener("pause", () => setPlaying(false), listen);
    video.addEventListener("ended", () => setPlaying(false), listen);
    toggle.addEventListener("click", () => {
        if (video.paused) void video.play().catch(() => {});
        else video.pause();
    }, listen);
    seek.addEventListener("input", () => {
        video.currentTime = seek.valueAsNumber;
        setPosition(video.currentTime);
    }, listen);
    return () => {
        events.abort();
        controls.destroy();
    };
}
