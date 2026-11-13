if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
    globalThis.browser = chrome;
}

const SERVER_URL = 'http://127.0.0.1:8000';

const DEFAULT_QUALITIES = [
    { value: '1080', label: '1080p (Full HD)' },
    { value: '720', label: '720p (HD)' },
    { value: '480', label: '480p' },
    { value: '360', label: '360p' },
    { value: 'audio', label: 'فقط صدا (M4A/MP3)' },
];

let state = {
    lastUrl: '',
    extractedPlaylist: null,
    isExtracting: false,
    allowPlaylist: false,
    queue: [],
    isDownloading: false,
    isPaused: false,
    isCancelling: false,
    statusText: 'آماده به کار',
    statusError: false,
    selectedQuality: '720',
    currentProgress: null,
};

let extractRequestId = 0;
let queueLoopToken = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function analyzeYoutubeUrl(rawUrl) {
    const result = {
        isValid: false,
        type: 'invalid', // 'single_only' | 'both' | 'playlist_only' | 'invalid'
        videoId: null,
        listId: null,
        singleUrl: null,
        playlistUrl: null,
    };
    if (!rawUrl || typeof rawUrl !== 'string') return result;

    let normalized = rawUrl.trim();
    if (!normalized) return result;
    if (!/^https?:\/\//i.test(normalized)) {
        normalized = 'https://' + normalized;
    }

    try {
        const u = new URL(normalized);
        const host = u.hostname.replace(/^www\./i, '').toLowerCase();
        const validHosts = [
            'youtube.com',
            'm.youtube.com',
            'music.youtube.com',
            'gaming.youtube.com',
            'youtu.be',
            'youtube-nocookie.com',
        ];
        if (!validHosts.includes(host)) return result;

        let rawVid = null;
        const rawList = u.searchParams.get('list');
        const pathParts = u.pathname.split('/').filter(Boolean);

        if (host === 'youtu.be') {
            rawVid = pathParts[0] || null;
        } else {
            if (u.searchParams.get('v')) {
                rawVid = u.searchParams.get('v');
            } else if (
                pathParts.length >= 2 &&
                ['shorts', 'live', 'embed', 'v', 'e'].includes(pathParts[0])
            ) {
                if (pathParts[1] !== 'videoseries') {
                    rawVid = pathParts[1];
                }
            }
        }

        const videoId = rawVid && rawVid.trim() ? rawVid.trim() : null;
        const listId = rawList && rawList.trim() ? rawList.trim() : null;

        if (videoId && listId) {
            result.type = 'both';
        } else if (videoId) {
            result.type = 'single_only';
        } else if (listId) {
            result.type = 'playlist_only';
        } else {
            return result;
        }

        result.isValid = true;
        result.videoId = videoId;
        result.listId = listId;
        result.singleUrl = videoId
            ? `https://www.youtube.com/watch?v=${videoId}`
            : null;

        if (listId) {
            if (listId.toUpperCase().startsWith('RD') && videoId) {
                result.playlistUrl = `https://www.youtube.com/watch?v=${videoId}&list=${listId}`;
            } else {
                result.playlistUrl = `https://www.youtube.com/playlist?list=${listId}`;
            }
        }
        return result;
    } catch (e) {
        return result;
    }
}

function getStorageState() {
    return new Promise((resolve) => {
        try {
            const res = browser.storage.local.get('downloaderState', (data) => {
                resolve(data || {});
            });
            if (res && typeof res.then === 'function') {
                res.then(resolve).catch(() => resolve({}));
            }
        } catch (e) {
            resolve({});
        }
    });
}

const initPromise = getStorageState().then((res) => {
    if (res && res.downloaderState) {
        state = { ...state, ...res.downloaderState };
        state.isExtracting = false;
        state.isCancelling = false;
        state.statusError = false;
        if (typeof state.allowPlaylist !== 'boolean') {
            state.allowPlaylist = false;
        }
        if (
            state.extractedPlaylist &&
            (!state.extractedPlaylist.qualities ||
                state.extractedPlaylist.qualities.length === 0)
        ) {
            state.extractedPlaylist.qualities = DEFAULT_QUALITIES;
        }
        if (state.isDownloading) {
            state.isDownloading = false;
            state.isPaused = true;
            state.queue.forEach((item) => {
                if (
                    ['downloading', 'checking', 'merging'].includes(item.status)
                ) {
                    item.status = 'waiting';
                    item.statusLabel = 'متوقف شده (آماده ادامه)';
                }
            });
            state.statusText =
                'مرورگر بسته شده بود. برای ادامه، دکمه «ادامه دانلود صف» را بزنید.';
            saveState();
        }
    }
});

function saveState() {
    try {
        browser.storage.local.set({ downloaderState: state });
    } catch (e) {}
    try {
        const p = browser.runtime.sendMessage({
            action: 'STATE_UPDATED',
            state,
        });
        if (p && typeof p.catch === 'function') {
            p.catch(() => {});
        }
    } catch (e) {}
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    initPromise.then(() => {
        if (message.action === 'GET_STATE') {
            sendResponse(state);
        } else if (message.action === 'SET_ALLOW_PLAYLIST') {
            state.allowPlaylist = Boolean(message.allowPlaylist);
            if (typeof message.url === 'string' && message.url.trim()) {
                state.lastUrl = message.url.trim();
            }
            if (message.statusText) {
                state.statusText = message.statusText;
                state.statusError = Boolean(message.statusError);
            }
            saveState();
            sendResponse(state);
        } else if (message.action === 'EXTRACT_PLAYLIST') {
            extractUrl(message.url, Boolean(message.allowPlaylist));
            sendResponse(state);
        } else if (message.action === 'SET_SELECTED_QUALITY') {
            state.selectedQuality = message.quality;
            saveState();
            sendResponse(state);
        } else if (message.action === 'TOGGLE_VIDEO_SELECT') {
            if (state.extractedPlaylist) {
                const vid = state.extractedPlaylist.videos.find(
                    (v) => v.index === message.index,
                );
                if (vid) vid.selected = message.selected;
                saveState();
            }
            sendResponse(state);
        } else if (message.action === 'SELECT_ALL_EXTRACTED') {
            if (state.extractedPlaylist) {
                state.extractedPlaylist.videos.forEach(
                    (v) => (v.selected = message.selectAll),
                );
                saveState();
            }
            sendResponse(state);
        } else if (message.action === 'ENQUEUE_SELECTED') {
            enqueueSelectedVideos(message.quality);
            sendResponse(state);
        } else if (message.action === 'PAUSE_QUEUE') {
            pauseQueue();
            sendResponse(state);
        } else if (message.action === 'RESUME_QUEUE') {
            resumeQueue();
            sendResponse(state);
        } else if (message.action === 'CANCEL_CURRENT') {
            cancelCurrentDownload();
            sendResponse(state);
        } else if (message.action === 'RETRY_ITEM') {
            retryQueueItem(message.item_id);
            sendResponse(state);
        } else if (message.action === 'RETRY_ALL_FAILED') {
            retryAllFailed();
            sendResponse(state);
        } else if (message.action === 'REMOVE_QUEUE_ITEM') {
            removeQueueItem(message.item_id);
            sendResponse(state);
        } else if (message.action === 'MOVE_QUEUE_ITEM') {
            moveQueueItem(message.item_id, message.direction);
            sendResponse(state);
        } else if (message.action === 'CLEAR_FINISHED') {
            state.queue = state.queue.filter((item) =>
                ['waiting', 'downloading', 'checking', 'merging'].includes(
                    item.status,
                ),
            );
            if (!state.isDownloading) {
                state.statusError = false;
                state.statusText = 'موارد تکمیل و لغو شده از لیست پاک شدند.';
            }
            saveState();
            sendResponse(state);
        } else if (message.action === 'CLEAR_ALL_QUEUE') {
            clearAllQueue();
            sendResponse(state);
        }
    });
    return true;
});

async function clearAllQueue() {
    queueLoopToken++;
    const wasDownloading = state.isDownloading;
    const itemsToClean = state.queue.filter(
        (i) => !['done', 'skipped'].includes(i.status),
    );
    state.queue = [];
    state.isDownloading = false;
    state.isPaused = false;
    state.isCancelling = false;
    state.currentProgress = null;
    state.statusError = false;
    state.statusText = 'کل صف دانلود پاک و صفر شد.';
    saveState();

    if (wasDownloading) {
        try {
            await fetch(`${SERVER_URL}/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'cancel' }),
            });
        } catch (e) {}
    }

    for (const item of itemsToClean) {
        try {
            await fetch(`${SERVER_URL}/cleanup_item`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item),
            });
        } catch (e) {}
    }
}

function retryQueueItem(itemId) {
    const item = state.queue.find((i) => i.item_id === itemId);
    if (item && ['error', 'cancelled'].includes(item.status)) {
        item.status = 'waiting';
        item.statusLabel = 'در صف انتظار';
        item.errorDetail = null;
        state.isPaused = false;
        state.statusError = false;
        saveState();
        if (!state.isDownloading) {
            processQueueLoop();
        }
    }
}

function retryAllFailed() {
    let count = 0;
    state.queue.forEach((item) => {
        if (['error', 'cancelled'].includes(item.status)) {
            item.status = 'waiting';
            item.statusLabel = 'در صف انتظار';
            item.errorDetail = null;
            count++;
        }
    });
    if (count > 0) {
        state.isPaused = false;
        state.statusError = false;
        state.statusText = `${count} ویدیوی خطاخورده مجدداً در صف قرار گرفتند.`;
        saveState();
        if (!state.isDownloading) {
            processQueueLoop();
        }
    }
}

async function pauseQueue() {
    state.isPaused = true;
    state.statusError = false;
    state.statusText = 'در حال توقف موقت دانلود...';
    saveState();
    try {
        await fetch(`${SERVER_URL}/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'pause' }),
        });
    } catch (e) {}
}

function resumeQueue() {
    state.isPaused = false;
    state.statusError = false;
    state.statusText = 'ادامه دانلود صف...';
    saveState();
    if (!state.isDownloading) {
        processQueueLoop();
    }
}

async function cancelCurrentDownload() {
    state.isCancelling = true;
    state.statusError = false;
    state.statusText = 'در حال لغو ویدیوی فعلی و پاک‌سازی فایل موقت...';
    saveState();
    try {
        await fetch(`${SERVER_URL}/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'cancel' }),
        });
    } catch (e) {}
}

async function removeQueueItem(itemId) {
    const idx = state.queue.findIndex((i) => i.item_id === itemId);
    if (idx === -1) return;

    const item = state.queue[idx];
    if (['checking', 'downloading', 'merging'].includes(item.status)) {
        item.removedByUser = true;
        await cancelCurrentDownload();
    } else {
        state.queue.splice(idx, 1);
        saveState();
        if (!['done', 'skipped'].includes(item.status)) {
            try {
                await fetch(`${SERVER_URL}/cleanup_item`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(item),
                });
            } catch (e) {}
        }
    }
}

function moveQueueItem(itemId, direction) {
    const idx = state.queue.findIndex((i) => i.item_id === itemId);
    if (idx === -1 || state.queue[idx].status !== 'waiting') return;

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= state.queue.length) return;
    if (
        ['checking', 'downloading', 'merging'].includes(
            state.queue[targetIdx].status,
        )
    )
        return;

    const temp = state.queue[idx];
    state.queue[idx] = state.queue[targetIdx];
    state.queue[targetIdx] = temp;
    saveState();
}

async function extractUrl(url, allowPlaylist) {
    const parsed = analyzeYoutubeUrl(url);

    if (!parsed.isValid) {
        state.statusError = true;
        state.statusText =
            'لینک واردشده معتبر نیست! لطفاً یک لینک صحیح یوتیوب وارد کنید.';
        saveState();
        return;
    }

    state.lastUrl = url.trim();

    if (parsed.type === 'single_only' && allowPlaylist) {
        state.allowPlaylist = false;
        state.statusError = true;
        state.statusText =
            'این لینک فقط مربوط به یک تک‌فیلم است و پلی‌لیستی ندارد! تیک پلی‌لیست خاموش ماند.';
        saveState();
        return;
    }

    if (parsed.type === 'playlist_only' && !allowPlaylist) {
        state.allowPlaylist = true;
        state.statusError = true;
        state.statusText =
            'این لینک مربوط به صفحه کلی پلی‌لیست است و تک‌فیلمی در آن مشخص نشده! تیک پلی‌لیست روشن ماند.';
        saveState();
        return;
    }

    state.allowPlaylist = Boolean(allowPlaylist);
    const currentReqId = ++extractRequestId;
    state.isExtracting = true;
    state.statusError = false;
    state.extractedPlaylist = null;

    const effectiveUrl =
        parsed.type === 'both'
            ? state.allowPlaylist
                ? parsed.playlistUrl
                : parsed.singleUrl
            : url;

    state.statusText = state.allowPlaylist
        ? 'در حال استخراج پلی‌لیست و کیفیت‌های موجود از یوتیوب...'
        : 'در حال استخراج اطلاعات تک‌فیلم و کیفیت‌های واقعی...';
    saveState();

    try {
        const response = await fetch(`${SERVER_URL}/extract`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: effectiveUrl,
                allow_playlist: state.allowPlaylist,
            }),
        });
        const data = await response.json();

        if (currentReqId !== extractRequestId) return;

        if (!response.ok || !data.videos || data.videos.length === 0) {
            if (typeof data.force_allow_playlist === 'boolean') {
                state.allowPlaylist = data.force_allow_playlist;
            }
            state.statusError = true;
            state.statusText = data.error || 'ویدیویی در این لینک پیدا نشد!';
            state.isExtracting = false;
            saveState();
            return;
        }

        const qualities =
            data.qualities && data.qualities.length > 0
                ? data.qualities
                : DEFAULT_QUALITIES;
        const has720 = qualities.some((q) => q.value === '720');
        state.selectedQuality = has720 ? '720' : qualities[0]?.value || '720';

        state.extractedPlaylist = {
            extract_id: `${Date.now()}`,
            url: url,
            resolved_url: data.resolved_url || effectiveUrl,
            url_type: parsed.type,
            is_playlist: Boolean(data.is_playlist),
            title: data.playlist_title,
            qualities: qualities,
            videos: data.videos.map((v) => ({
                ...v,
                selected: true,
            })),
        };

        state.statusError = false;
        if (data.is_playlist) {
            state.statusText = `پلی‌لیست «${data.playlist_title}» (${data.videos.length} ویدیو) آماده انتخاب است.`;
        } else {
            state.statusText = `تک‌فیلم استخراج شد (${qualities.length} کیفیت موجود).`;
        }
    } catch (err) {
        if (currentReqId !== extractRequestId) return;
        state.statusError = true;
        state.statusText =
            'خطا: سرور پایتون روشن نیست یا به نسخه جدید آپدیت نشده است!';
    }

    state.isExtracting = false;
    saveState();
}

function enqueueSelectedVideos(quality) {
    if (!state.extractedPlaylist) return;
    const selectedVideos = state.extractedPlaylist.videos.filter(
        (v) => v.selected,
    );
    if (selectedVideos.length === 0) {
        state.statusError = true;
        state.statusText = 'لطفاً حداقل یک ویدیو را تیک بزنید!';
        saveState();
        return;
    }

    const playlistTitle = state.extractedPlaylist.title;
    const chosenQuality = quality || state.selectedQuality || '720';
    let addedCount = 0;

    selectedVideos.forEach((v) => {
        const existingItem = state.queue.find(
            (q) =>
                q.url === v.url &&
                q.playlist_title === playlistTitle &&
                q.quality === chosenQuality,
        );
        if (
            existingItem &&
            ['error', 'cancelled'].includes(existingItem.status)
        ) {
            existingItem.status = 'waiting';
            existingItem.statusLabel = 'در صف انتظار';
            existingItem.errorDetail = null;
            addedCount++;
        } else if (!existingItem) {
            state.queue.push({
                item_id: `${Date.now()}_${v.index}_${Math.random().toString(36).slice(2, 7)}`,
                index: v.index,
                title: v.title,
                url: v.url,
                duration: v.duration,
                is_single: Boolean(v.is_single),
                playlist_title: playlistTitle,
                quality: chosenQuality,
                status: 'waiting',
                statusLabel: 'در صف انتظار',
            });
            addedCount++;
        }
    });

    state.extractedPlaylist = null;
    state.isPaused = false;
    state.statusError = false;
    state.statusText =
        addedCount > 0
            ? `${addedCount} مورد به صف دانلود اضافه شد.`
            : 'موارد انتخابی با همین کیفیت از قبل در صف وجود داشتند.';
    saveState();

    if (!state.isDownloading) {
        processQueueLoop();
    }
}

async function processQueueLoop() {
    if (state.isDownloading) return;
    const myToken = ++queueLoopToken;
    state.isDownloading = true;
    state.isCancelling = false;
    state.statusError = false;
    let connectionLost = false;
    saveState();

    while (myToken === queueLoopToken) {
        if (state.isPaused || state.queue.length === 0) break;

        const nextItem = state.queue.find((item) => item.status === 'waiting');
        if (!nextItem) break;

        const prefixTitle = nextItem.is_single
            ? nextItem.title
            : `${nextItem.index}. ${nextItem.title}`;
        nextItem.status = 'checking';
        nextItem.statusLabel = 'بررسی فایل...';
        state.isCancelling = false;
        state.statusError = false;
        state.statusText = `در حال دانلود: ${prefixTitle}`;
        state.currentProgress = {
            item_id: nextItem.item_id,
            title: prefixTitle,
            playlist: nextItem.playlist_title,
            percent: nextItem.lastPercent || 0,
            downloaded: '0 B',
            total: '...',
            speed: '0 B/s',
            eta: '--:--',
            message: 'در حال آماده‌سازی...',
        };
        saveState();

        try {
            let startRes = null;
            let alreadyActiveOnServer = false;

            for (let attempt = 0; attempt < 5; attempt++) {
                startRes = await fetch(`${SERVER_URL}/start_download`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(nextItem),
                });
                if (startRes.status === 409) {
                    const errBody = await startRes.json().catch(() => ({}));
                    if (errBody.active_item_id === nextItem.item_id) {
                        alreadyActiveOnServer = true;
                        break;
                    }
                    await sleep(1000);
                } else {
                    break;
                }
            }

            if (myToken !== queueLoopToken) return;

            if ((!startRes || !startRes.ok) && !alreadyActiveOnServer) {
                nextItem.status = 'error';
                nextItem.statusLabel = 'خطای سرور ✗';
                saveState();
                continue;
            }

            let finished = false;
            let mismatchCount = 0;

            while (!finished && myToken === queueLoopToken) {
                await sleep(800);
                if (myToken !== queueLoopToken || state.queue.length === 0) {
                    finished = true;
                    break;
                }

                const progRes = await fetch(`${SERVER_URL}/progress`);
                const prog = await progRes.json();

                if (prog.item_id !== nextItem.item_id) {
                    mismatchCount++;
                    if (!prog.active || mismatchCount > 5) {
                        nextItem.status = 'error';
                        nextItem.statusLabel = 'ریست سرور ✗';
                        finished = true;
                        saveState();
                        break;
                    }
                    continue;
                }
                mismatchCount = 0;

                state.currentProgress = {
                    item_id: nextItem.item_id,
                    title: prefixTitle,
                    playlist: nextItem.playlist_title,
                    percent: prog.percent || 0,
                    downloaded: prog.downloaded || '0 B',
                    total: prog.total || '...',
                    speed: prog.speed || '0 B/s',
                    eta: prog.eta || '--:--',
                    message: prog.message || '',
                };

                if (prog.status === 'downloading') {
                    nextItem.status = 'downloading';
                    nextItem.lastPercent = prog.percent;
                    nextItem.statusLabel = `${prog.percent}%`;
                } else if (prog.status === 'merging') {
                    nextItem.status = 'merging';
                    nextItem.statusLabel = 'نهایی‌سازی...';
                }

                if (!prog.active) {
                    finished = true;
                    state.isCancelling = false;

                    if (nextItem.removedByUser) {
                        state.queue = state.queue.filter(
                            (q) => q.item_id !== nextItem.item_id,
                        );
                    } else if (prog.status === 'completed') {
                        nextItem.status = 'done';
                        nextItem.statusLabel = 'تکمیل شد ✓';
                    } else if (prog.status === 'skipped') {
                        nextItem.status = 'skipped';
                        nextItem.statusLabel = 'از قبل موجود ✓';
                    } else if (prog.status === 'paused') {
                        nextItem.status = 'waiting';
                        nextItem.statusLabel = `متوقف (${prog.percent || 0}%)`;
                        state.isPaused = true;
                    } else if (prog.status === 'cancelled') {
                        nextItem.status = 'cancelled';
                        nextItem.statusLabel = 'لغو شد ✕';
                    } else {
                        nextItem.status = 'error';
                        nextItem.statusLabel = 'خطا ✗';
                        nextItem.errorDetail = prog.error || prog.message;
                    }
                }
                saveState();
            }
        } catch (e) {
            if (myToken !== queueLoopToken) return;
            nextItem.status = 'error';
            nextItem.statusLabel = 'قطع ارتباط ✗';
            connectionLost = true;
            saveState();
            break;
        }
    }

    if (myToken !== queueLoopToken) return;

    state.isDownloading = false;
    state.isCancelling = false;
    state.currentProgress = null;

    const hasWaiting = state.queue.some((i) => i.status === 'waiting');

    if (state.queue.length === 0) {
        state.isPaused = false;
        state.statusError = false;
        state.statusText = 'کل صف دانلود پاک و صفر شد.';
    } else if (connectionLost) {
        state.statusError = true;
        state.statusText =
            'ارتباط با سرور پایتون قطع شد! سرور را بررسی کرده و مجدداً تلاش کنید.';
    } else if (state.isPaused && hasWaiting) {
        state.statusError = false;
        state.statusText = 'صف دانلود به صورت موقت متوقف شد.';
    } else {
        state.isPaused = false;
        const failedCount = state.queue.filter((i) =>
            ['error', 'cancelled'].includes(i.status),
        ).length;
        if (!hasWaiting) {
            if (failedCount > 0) {
                state.statusError = true;
                state.statusText = `پردازش صف تمام شد (${failedCount} مورد ناموفق یا لغوشده).`;
            } else {
                state.statusError = false;
                state.statusText = 'پردازش تمام موارد صف به پایان رسید! 🎉';
            }
        }
    }
    saveState();
}
