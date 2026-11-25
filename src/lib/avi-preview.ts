import { createExpandButton, createPlaybackControls, createPlaybackPicture } from "./media-preview";

type Chunk = { id: string; data: number; size: number; end: number };
type Frame = { offset: number; size: number };
type Track = { stream: string; fps: number; bitmap?: DataView<ArrayBuffer> };
type AudioTrack = { stream: string; format: DataView<ArrayBuffer>; block: number; float: boolean };
type Movie = Track & { frames: Frame[]; audio?: AudioTrack & { packets: Frame[] } };

const maxRead = 32 * 1024 * 1024;
const maxAudioBytes = 64 * 1024 * 1024;
const pageSize = 256 * 1024;

function fourcc(data: DataView, offset: number): string {
    return String.fromCharCode(data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2), data.getUint8(offset + 3));
}

class AviReader {
    private page?: { offset: number; data: ArrayBuffer };
    private count = 0;

    constructor(readonly url: string, readonly size: number, readonly signal: AbortSignal) {}

    async read(offset: number, length: number): Promise<DataView<ArrayBuffer>> {
        if (offset < 0 || length < 1 || length > maxRead || offset + length > this.size) {
            throw new Error("Invalid AVI data size");
        }
        let page = this.page;
        if (!page || offset < page.offset || offset + length > page.offset + page.data.byteLength) {
            const end = Math.min(this.size, offset + Math.max(length, pageSize)) - 1;
            const response = await fetch(this.url, { headers: { Range: "bytes=" + offset + "-" + end }, signal: this.signal });
            if (response.status !== 206 || response.headers.get("Content-Range") !== "bytes " + offset + "-" + end + "/" + this.size) {
                throw new Error("Could not read AVI byte range");
            }
            const data = await response.arrayBuffer();
            if (data.byteLength !== end - offset + 1) throw new Error("Truncated AVI data");
            this.page = page = { offset, data };
        }
        return new DataView(page.data, offset - page.offset, length);
    }

    async *chunks(from: number, end: number): AsyncGenerator<Chunk> {
        while (from < end) {
            if (++this.count > 1_000_000 || end - from < 8) throw new Error("Invalid AVI chunk structure");
            const header = await this.read(from, 8);
            const size = header.getUint32(4, true);
            const data = from + 8;
            from = data + size + (size & 1);
            if (from > end) throw new Error("AVI chunk exceeds its list");
            yield { id: fourcc(header, 0), data, size, end: data + size };
        }
    }

    async listType(chunk: Chunk): Promise<string> {
        if (chunk.size < 4) throw new Error("Invalid AVI list");
        return fourcc(await this.read(chunk.data, 4), 0);
    }
}

function readAudioTrack(stream: string, header: DataView, format?: DataView<ArrayBuffer>): AudioTrack | undefined {
    if (!format || header.getUint32(28, true) !== 0) return;
    const encoding = format.getUint16(0, true);
    const channels = format.getUint16(2, true);
    const rate = format.getUint32(4, true);
    const block = format.getUint16(12, true);
    const bits = format.getUint16(14, true);
    const float = encoding === 3 && bits === 32;
    if (!float && !(encoding === 1 && [8, 16, 24, 32].includes(bits))) return;
    if (channels < 1 || channels > 8 || rate < 1000 || rate > 384000 || block !== channels * (bits / 8)) return;
    return { stream, format, block, float };
}

async function readTracks(reader: AviReader, list: Chunk): Promise<{ video?: Track; audio?: AudioTrack }> {
    let index = 0;
    let video: Track | undefined;
    let audio: AudioTrack | undefined;
    for await (const stream of reader.chunks(list.data + 4, list.end)) {
        if (stream.id !== "LIST" || await reader.listType(stream) !== "strl") continue;
        const streamId = String(index++).padStart(2, "0");
        if (index > 100) throw new Error("Too many AVI streams");
        let header: DataView | undefined;
        let format: DataView<ArrayBuffer> | undefined;
        for await (const chunk of reader.chunks(stream.data + 4, stream.end)) {
            if (chunk.id === "strh" && chunk.size >= 56) header = await reader.read(chunk.data, 56);
            if (chunk.id === "strf" && chunk.size >= 16) format = await reader.read(chunk.data, Math.min(chunk.size, 40));
        }
        if (!header) continue;
        const kind = fourcc(header, 0);
        if (kind === "auds" && !audio) audio = readAudioTrack(streamId, header, format);
        if (kind !== "vids" || video) continue;

        const fps = header.getUint32(24, true) / header.getUint32(20, true);
        if (!format || format.byteLength < 40 || format.getUint32(0, true) < 40 || !(fps > 0 && Number.isFinite(fps))) {
            throw new Error("Invalid AVI video stream");
        }
        if (fourcc(format, 16).toUpperCase() === "MJPG") {
            video = { stream: streamId, fps };
            continue;
        }

        const width = format.getInt32(4, true);
        const height = Math.abs(format.getInt32(8, true));
        if (format.getUint32(16, true) === 0 && format.getUint16(12, true) === 1 && format.getUint16(14, true) === 24 &&
            width > 0 && height > 0 && ((width * 3 + 3) & ~3) * height <= maxRead && width <= 16384 && height <= 16384) {
            video = { stream: streamId, fps, bitmap: format };
            continue;
        }
        throw new Error("Unsupported AVI video codec");
    }
    return { video, audio };
}

async function indexedPackets(reader: AviReader, index: Chunk, movie: Chunk, matches: (id: string) => boolean, limit: number): Promise<Frame[]> {
    if (!index.size || index.size % 16 || index.size > maxRead) return [];
    const data = await reader.read(index.data, index.size);
    const frames: Frame[] = [];
    let base: number | undefined;
    for (let pos = 0; pos < data.byteLength; pos += 16) {
        const id = fourcc(data, pos);
        if (!matches(id)) continue;
        const offset = data.getUint32(pos + 8, true);
        const size = data.getUint32(pos + 12, true);
        if (!size) continue;
        if (base === undefined) {
            // AVI indexes can use offsets relative to the movie list or the file.
            for (const candidate of [movie.data, movie.data + 4, 0]) {
                const start = candidate + offset;
                if (start < movie.data + 4 || start + 8 + size > movie.end) continue;
                const header = await reader.read(start, 8);
                if (fourcc(header, 0) === id && header.getUint32(4, true) === size) {
                    base = candidate;
                    break;
                }
            }
            if (base === undefined) return [];
        }
        const frameOffset = base + offset + 8;
        if (frameOffset < movie.data + 12 || frameOffset + size > movie.end || size > limit) return [];
        frames.push({ offset: frameOffset, size });
    }
    return frames;
}

async function scanPackets(reader: AviReader, from: number, end: number, matches: (id: string) => boolean, limit: number,
                           packets: Frame[], depth = 0): Promise<void> {
    if (depth > 8) throw new Error("Too many nested AVI lists");
    for await (const chunk of reader.chunks(from, end)) {
        if (matches(chunk.id) && chunk.size) {
            if (chunk.size > limit) throw new Error("AVI packet exceeds the preview limit");
            packets.push({ offset: chunk.data, size: chunk.size });
        } else if (chunk.id === "LIST" && await reader.listType(chunk) === "rec ") {
            await scanPackets(reader, chunk.data + 4, chunk.end, matches, limit, packets, depth + 1);
        }
    }
}

async function readMovie(reader: AviReader): Promise<Movie> {
    const riff = await reader.read(0, 12);
    if (fourcc(riff, 0) !== "RIFF" || fourcc(riff, 8) !== "AVI " || riff.getUint32(4, true) + 8 !== reader.size) {
        throw new Error("Invalid or segmented AVI");
    }

    let tracks: Awaited<ReturnType<typeof readTracks>> | undefined;
    let movie: Chunk | undefined;
    let index: Chunk | undefined;
    for await (const chunk of reader.chunks(12, reader.size)) {
        if (chunk.id === "idx1") index = chunk;
        if (chunk.id !== "LIST") continue;
        const type = await reader.listType(chunk);
        if (type === "hdrl") tracks = await readTracks(reader, chunk);
        if (type === "movi") movie = chunk;
    }
    if (!tracks?.video || !movie) throw new Error("Invalid AVI structure");
    const { video, audio } = tracks;
    const movi = movie;
    async function readPackets(matches: (id: string) => boolean, limit: number): Promise<Frame[]> {
        const packets = index ? await indexedPackets(reader, index, movi, matches, limit) : [];
        if (!packets.length) await scanPackets(reader, movi.data + 4, movi.end, matches, limit, packets);
        return packets;
    }
    const frames = await readPackets((id) => id === video.stream + "dc" || id === video.stream + "db", maxRead);
    if (!frames.length) throw new Error("AVI has no video frames");
    if (!audio) return { ...video, frames };
    const packets = await readPackets((id) => id === audio.stream + "wb", maxAudioBytes).catch(() => []);
    return { ...video, frames, audio: packets.length ? { ...audio, packets } : undefined };
}

async function readWave(reader: AviReader, audio: NonNullable<Movie["audio"]>): Promise<Blob> {
    const size = audio.packets.reduce((sum, packet) => sum + packet.size, 0);
    if (size > maxAudioBytes || audio.packets.some((packet) => packet.size % audio.block)) {
        throw new Error("AVI audio exceeds the preview limit or has incomplete samples");
    }

    const header = new Uint8Array(audio.float ? 58 : 44);
    const encoder = new TextEncoder();
    const fields = new DataView(header.buffer);
    const put = (offset: number, value: number) => fields.setUint32(offset, value, true);
    const padding = size % 2;
    header.set(encoder.encode("RIFF"));
    put(4, header.length - 8 + size + padding);
    header.set(encoder.encode("WAVEfmt "), 8);
    put(16, audio.float ? 18 : 16);
    header.set(new Uint8Array(audio.format.buffer, audio.format.byteOffset, 16), 20);
    put(28, audio.format.getUint32(4, true) * audio.block);
    if (audio.float) {
        header.set(encoder.encode("fact"), 38);
        put(42, 4);
        put(46, size / audio.block);
    }
    header.set(encoder.encode("data"), header.length - 8);
    put(header.length - 4, size);

    const parts = [header];
    for (const packet of audio.packets) {
        for (let start = 0; start < packet.size; start += pageSize) {
            const data = await reader.read(packet.offset + start, Math.min(pageSize, packet.size - start));
            parts.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
        }
    }
    if (padding) parts.push(new Uint8Array(1));
    return new Blob(parts, { type: "audio/wav" });
}

function frameImage(frame: DataView<ArrayBuffer>, bitmap?: DataView<ArrayBuffer>): Blob {
    const data = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    if (!bitmap) {
        if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error("Invalid JPEG frame");
        return new Blob([data], { type: "image/jpeg" });
    }
    const stride = (bitmap.getInt32(4, true) * 3 + 3) & ~3;
    if (stride * Math.abs(bitmap.getInt32(8, true)) !== frame.byteLength) throw new Error("Invalid RGB frame size");
    const header = new DataView(new ArrayBuffer(54));
    header.setUint16(0, 0x4d42, true);
    header.setUint32(2, header.byteLength + frame.byteLength, true);
    header.setUint32(10, header.byteLength, true);
    new Uint8Array(header.buffer).set(new Uint8Array(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength), 14);
    header.setUint32(14, 40, true);
    header.setUint32(34, frame.byteLength, true);
    return new Blob([header, data], { type: "image/bmp" });
}

export function createAviPreview(card: HTMLElement, url: string, path: string, unavailable: () => void,
                                 options: { initialFrame?: number; onExpand?: (frame: number) => void } = {}) {
    const document = card.ownerDocument;
    const player = card.appendChild(document.createElement("div"));
    player.className = "dgl-preview-player";
    const image = document.createElement("img");
    image.alt = path;
    const onExpand = options.onExpand;
    const picture = player.appendChild(onExpand
        ? createExpandButton(image, "Expand video " + path, () => {
            stop();
            onExpand(seek.valueAsNumber);
        })
        : createPlaybackPicture(image));
    const controls = createPlaybackControls(player, onExpand ? { expand: picture } : { picture });
    const { toggle, seek, enablePlay, setPlaying, setDuration, setPosition } = controls;

    const abort = new AbortController();
    let reader: AviReader | undefined;
    let movie: Movie | undefined;
    let audio: HTMLAudioElement | undefined;
    let audioUrl = "";
    let imageUrl = "";
    let clock: number | undefined;
    let timer = 0;
    let requested = 0;
    let shown = -1;
    let drawing = false;

    function stop(): void {
        clock = undefined;
        cancelAnimationFrame(timer);
        audio?.pause();
        setPlaying(false);
    }
    stop();

    function destroy(): void {
        stop();
        controls.destroy();
        abort.abort();
        if (audio) {
            audio.removeAttribute("src");
            audio.load();
            audio.remove();
        }
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        audioUrl = "";
        image.removeAttribute("src");
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = "";
    }

    function fail(): void {
        if (abort.signal.aborted) return;
        destroy();
        player.hidden = true;
        unavailable();
    }

    async function showFrame(index: number): Promise<void> {
        requested = index;
        if (!reader || !movie || drawing) return;
        drawing = true;
        try {
            while (requested !== shown && !abort.signal.aborted) {
                const next = requested;
                const frame = movie.frames[next];
                const bytes = await reader.read(frame.offset, frame.size);
                if (abort.signal.aborted) break;
                if (requested !== next) continue;
                if (imageUrl) URL.revokeObjectURL(imageUrl);
                imageUrl = URL.createObjectURL(frameImage(bytes, movie.bitmap));
                image.src = imageUrl;
                shown = next;
            }
        } catch {
            fail();
        } finally {
            drawing = false;
        }
    }

    function tick(now: number): void {
        if (!movie || clock === undefined) return;
        let elapsed = Math.max(0, (now - clock) / 1000);
        if (audio && !audio.paused && !audio.ended) {
            elapsed = audio.currentTime;
            clock = now - elapsed * 1000;
        }
        const frame = Math.min(movie.frames.length - 1, Math.floor(elapsed * movie.fps));
        setPosition(frame);
        void showFrame(frame);
        if (elapsed * movie.fps < movie.frames.length) timer = requestAnimationFrame(tick);
        else stop();
    }

    function seekTo(frame: number): void {
        if (movie) {
            const position = frame / movie.fps;
            if (clock !== undefined) clock = performance.now() - position * 1000;
            if (audio) audio.currentTime = Math.min(position, Number.isFinite(audio.duration) ? audio.duration : position);
        }
        setPosition(frame);
        void showFrame(frame);
    }

    toggle.addEventListener("click", () => {
        if (!movie || abort.signal.aborted) return;
        if (clock !== undefined) {
            stop();
            return;
        }
        const frame = seek.value === seek.max ? 0 : Number(seek.value);
        const position = frame / movie.fps;
        seekTo(frame);
        clock = performance.now() - position * 1000;
        if (audio && (!Number.isFinite(audio.duration) || position < audio.duration)) {
            void audio.play().catch(() => {});
        }
        setPlaying(true);
        timer = requestAnimationFrame(tick);
    });
    seek.addEventListener("input", () => seekTo(Number(seek.value)));
    image.addEventListener("error", fail);

    async function load(preflight?: Response): Promise<void> {
        try {
            const response = preflight ?? await fetch(url, { method: "HEAD", signal: abort.signal });
            const size = Number(response.headers.get("Content-Length"));
            if (!response.ok || !Number.isSafeInteger(size) || size < 12) throw new Error("Cannot open AVI");
            reader = new AviReader(url, size, abort.signal);
            movie = await readMovie(reader);
            if (abort.signal.aborted) return;
            const frame = Math.min(Math.max(0, options.initialFrame ?? 0), movie.frames.length - 1);
            await showFrame(frame);
            if (abort.signal.aborted) return;
            if (movie.audio) {
                const wave = await readWave(reader, movie.audio).catch(() => undefined);
                if (abort.signal.aborted) return;
                if (wave) {
                    audioUrl = URL.createObjectURL(wave);
                    audio = player.appendChild(document.createElement("audio"));
                    audio.hidden = true;
                    audio.preload = "auto";
                    audio.src = audioUrl;
                    controls.addAudio(audio);
                }
            }
            setDuration(movie.frames.length - 1, movie.fps, movie.frames.length / movie.fps);
            seekTo(frame);
            if (image.complete && image.naturalWidth) enablePlay();
            else image.addEventListener("load", enablePlay, { once: true, signal: abort.signal });
        } catch {
            fail();
        }
    }

    return { load, destroy };
}
