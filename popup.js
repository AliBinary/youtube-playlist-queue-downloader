if (typeof browser === 'undefined' && typeof chrome !== 'undefined') {
    globalThis.browser = chrome;
}

function sendMsg(msg) {
    return new Promise((resolve) => {
        try {
            const res = browser.runtime.sendMessage(msg, (response) => {
                resolve(response);
            });
            if (res && typeof res.then === 'function') {
                res.then(resolve).catch(() => resolve(null));
            }
        } catch (e) {
            resolve(null);
        }
    });
}

function queryActiveTabs() {
    return new Promise((resolve) => {
        try {
            const res = browser.tabs.query(
                { active: true, currentWindow: true },
                (tabs) => resolve(tabs || []),
            );
            if (res && typeof res.then === 'function') {
                res.then(resolve).catch(() => resolve([]));
            }
        } catch (e) {
            resolve([]);
        }
    });
}

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

const ICONS = {
    folder: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
    up: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`,
    down: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
    close: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
    retry: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`,
    play: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
};

const urlInput = document.getElementById('playlistUrl');
const allowPlaylistCheckbox = document.getElementById('allowPlaylistCheckbox');
const modeLabel = document.getElementById('modeLabel');
const linkTypeBadge = document.getElementById('linkTypeBadge');
const extractBtn = document.getElementById('extractBtn');
const statusBar = document.getElementById('statusBar');
const statusEl = document.getElementById('status');
const statusDot = document.getElementById('statusDot');

const liveBox = document.getElementById('live-progress-box');
const progTitle = document.getElementById('prog-title');
const progPl = document.getElementById('prog-pl');
const progFill = document.getElementById('prog-fill');
const progPct = document.getElementById('prog-pct');
const progSize = document.getElementById('prog-size');
const progSpeed = document.getElementById('prog-speed');
const progEta = document.getElementById('prog-eta');
const pauseResumeBtn = document.getElementById('pauseResumeBtn');
const cancelCurrentBtn = document.getElementById('cancelCurrentBtn');
const resumeBannerBtn = document.getElementById('resumeBannerBtn');

const selectionSection = document.getElementById('selection-section');
const extractedPlTitle = document.getElementById('extracted-pl-title');
const customFolderInput = document.getElementById('customFolderInput');
const selectAllContainer = document.getElementById('selectAllContainer');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const extractListEl = document.getElementById('extract-list');
const qualitySelect = document.getElementById('quality');
const enqueueBtn = document.getElementById('enqueueBtn');

const queueSection = document.getElementById('queue-section');
const queueListEl = document.getElementById('queue-list');
const queueCounter = document.getElementById('queue-counter');
const clearFinishedBtn = document.getElementById('clearFinishedBtn');
const clearAllBtn = document.getElementById('clearAllBtn');

const FALLBACK_QUALITIES = [
    { value: '1080', label: '1080p (Full HD)' },
    { value: '720', label: '720p (HD)' },
    { value: '480', label: '480p' },
    { value: '360', label: '360p' },
    { value: 'audio', label: 'فقط صدا (M4A/MP3)' },
];

let lastRenderedExtractSignature = null;

function triggerShake() {
    if (!modeLabel) return;
    modeLabel.classList.remove('shake');
    void modeLabel.offsetWidth;
    modeLabel.classList.add('shake');
}

function updateLinkBadgeAndToggle(rawUrl, syncWithBg = false) {
    const info = analyzeYoutubeUrl(rawUrl);
    if (!linkTypeBadge) return info;

    linkTypeBadge.className = 'link-type-badge';
    if (info.type === 'single_only') {
        linkTypeBadge.textContent = 'تک‌فیلم';
        linkTypeBadge.classList.add('t-single');
        allowPlaylistCheckbox.checked = false;
        if (syncWithBg) {
            sendMsg({
                action: 'SET_ALLOW_PLAYLIST',
                url: rawUrl,
                allowPlaylist: false,
            });
        }
    } else if (info.type === 'both') {
        linkTypeBadge.textContent = 'ویدیو + پلی‌لیست';
        linkTypeBadge.classList.add('t-both');
        if (syncWithBg) {
            sendMsg({
                action: 'SET_ALLOW_PLAYLIST',
                url: rawUrl,
                allowPlaylist: allowPlaylistCheckbox.checked,
            });
        }
    } else if (info.type === 'playlist_only') {
        linkTypeBadge.textContent = 'پلی‌لیست کامل';
        linkTypeBadge.classList.add('t-playlist');
        allowPlaylistCheckbox.checked = true;
        if (syncWithBg) {
            sendMsg({
                action: 'SET_ALLOW_PLAYLIST',
                url: rawUrl,
                allowPlaylist: true,
            });
        }
    } else {
        linkTypeBadge.textContent = rawUrl.trim()
            ? 'لینک نامعتبر'
            : 'بدون لینک';
    }
    return info;
}

function renderUI(state) {
    if (!state) return;

    statusEl.textContent = state.statusText;
    extractBtn.disabled = state.isExtracting;
    extractBtn.classList.toggle('loading', Boolean(state.isExtracting));

    const isBusy = Boolean(state.isExtracting || state.isDownloading);
    const isErr = Boolean(state.statusError) && !isBusy;

    if (statusBar) {
        statusBar.classList.toggle('error', isErr);
    }
    if (statusDot) {
        statusDot.classList.toggle('busy', isBusy);
        statusDot.classList.toggle('error', isErr);
    }

    if (typeof state.allowPlaylist === 'boolean') {
        allowPlaylistCheckbox.checked = state.allowPlaylist;
    }

    if (!urlInput.value.trim()) {
        if (state.extractedPlaylist && state.extractedPlaylist.url) {
            urlInput.value = state.extractedPlaylist.url;
        } else if (state.lastUrl) {
            urlInput.value = state.lastUrl;
        }
    }

    updateLinkBadgeAndToggle(urlInput.value, false);

    const hasWaiting =
        state.queue && state.queue.some((i) => i.status === 'waiting');
    const hasFailed =
        state.queue &&
        state.queue.some((i) => ['error', 'cancelled'].includes(i.status));

    if (state.isDownloading && state.currentProgress) {
        const p = state.currentProgress;
        liveBox.style.display = 'block';
        resumeBannerBtn.style.display = 'none';
        progTitle.textContent = p.title;
        progPl.textContent = `پوشه: ${p.playlist} • ${p.message}`;
        progFill.style.width = `${p.percent}%`;
        progPct.textContent = `${p.percent}%`;
        progSize.textContent = `${p.downloaded} / ${p.total}`;
        progSpeed.textContent = p.speed;
        progEta.textContent = `ETA: ${p.eta}`;

        pauseResumeBtn.disabled = Boolean(state.isPaused || state.isCancelling);
        cancelCurrentBtn.disabled = Boolean(state.isCancelling);
    } else {
        liveBox.style.display = 'none';
        if (state.isPaused && hasWaiting) {
            resumeBannerBtn.style.display = 'inline-flex';
            resumeBannerBtn.innerHTML = `${ICONS.play} <span>ادامه دانلود صف (Resume)</span>`;
            resumeBannerBtn.onclick = async () => {
                const s = await sendMsg({ action: 'RESUME_QUEUE' });
                renderUI(s);
            };
        } else if (hasWaiting && !state.isDownloading) {
            resumeBannerBtn.style.display = 'inline-flex';
            resumeBannerBtn.innerHTML = `${ICONS.play} <span>ادامه دانلود موارد باقی‌مانده صف</span>`;
            resumeBannerBtn.onclick = async () => {
                const s = await sendMsg({ action: 'RESUME_QUEUE' });
                renderUI(s);
            };
        } else if (hasFailed && !state.isDownloading) {
            resumeBannerBtn.style.display = 'inline-flex';
            resumeBannerBtn.innerHTML = `${ICONS.retry} <span>تلاش مجدد برای همه موارد خطاخورده</span>`;
            resumeBannerBtn.onclick = async () => {
                const s = await sendMsg({ action: 'RETRY_ALL_FAILED' });
                renderUI(s);
            };
        } else {
            resumeBannerBtn.style.display = 'none';
        }
    }

    if (state.extractedPlaylist && state.extractedPlaylist.videos.length > 0) {
        selectionSection.style.display = 'block';
        const vids = state.extractedPlaylist.videos;
        const isPl = state.extractedPlaylist.is_playlist;
        const selectedCount = vids.filter((v) => v.selected).length;

        if (isPl) {
            extractedPlTitle.textContent = `ویدیوهای پلی‌لیست (${selectedCount} از ${vids.length} انتخاب شده)`;
            selectAllContainer.style.display = 'flex';
            selectAllCheckbox.checked = selectedCount === vids.length;
        } else {
            extractedPlTitle.textContent = 'مشخصات و نام فایل تک‌فیلم:';
            selectAllContainer.style.display = 'none';
        }

        if (document.activeElement !== customFolderInput) {
            customFolderInput.value = state.extractedPlaylist.title || '';
        }

        const qualities =
            state.extractedPlaylist.qualities &&
            state.extractedPlaylist.qualities.length > 0
                ? state.extractedPlaylist.qualities
                : FALLBACK_QUALITIES;

        const currentSignature = JSON.stringify({
            id:
                state.extractedPlaylist.extract_id ||
                state.extractedPlaylist.url,
            vLen: vids.length,
            qLen: qualities.length,
        });

        if (currentSignature !== lastRenderedExtractSignature) {
            lastRenderedExtractSignature = currentSignature;

            qualitySelect.innerHTML = '';
            qualities.forEach((q) => {
                const opt = document.createElement('option');
                opt.value = q.value;
                opt.textContent = q.label;
                if (q.value === state.selectedQuality) {
                    opt.selected = true;
                }
                qualitySelect.appendChild(opt);
            });

            extractListEl.innerHTML = '';
            vids.forEach((v) => {
                const li = document.createElement('li');
                const rowDiv = document.createElement('div');
                rowDiv.className = 'vid-row';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.dataset.vidIndex = String(v.index);
                cb.checked = v.selected;
                cb.title = 'انتخاب برای دانلود';
                cb.addEventListener('change', async () => {
                    const s = await sendMsg({
                        action: 'TOGGLE_VIDEO_SELECT',
                        index: v.index,
                        selected: cb.checked,
                    });
                    renderUI(s);
                });
                rowDiv.appendChild(cb);

                if (!v.is_single) {
                    const idxBadge = document.createElement('span');
                    idxBadge.className = 'vid-index-badge';
                    idxBadge.textContent = String(v.index).padStart(2, '0');
                    idxBadge.title = 'شماره ردیف در پلی‌لیست';
                    rowDiv.appendChild(idxBadge);
                }

                const titleInput = document.createElement('input');
                titleInput.type = 'text';
                titleInput.className = 'vid-title-input';
                titleInput.dataset.vidTitleIndex = String(v.index);
                titleInput.value = v.title;
                titleInput.placeholder = 'نام فایل خروجی...';
                titleInput.title =
                    'می‌توانید نام فایل خروجی را اینجا تغییر دهید';
                titleInput.addEventListener('input', () => {
                    sendMsg({
                        action: 'UPDATE_EXTRACTED_VIDEO_TITLE',
                        index: v.index,
                        title: titleInput.value,
                    });
                });

                rowDiv.appendChild(titleInput);
                li.appendChild(rowDiv);
                extractListEl.appendChild(li);
            });
        } else {
            const checkboxes = extractListEl.querySelectorAll(
                'input[type="checkbox"]',
            );
            checkboxes.forEach((cb) => {
                const idx = Number(cb.dataset.vidIndex);
                const found = vids.find((v) => v.index === idx);
                if (found && cb.checked !== found.selected) {
                    cb.checked = found.selected;
                }
            });

            const titleInputs = extractListEl.querySelectorAll(
                'input.vid-title-input',
            );
            titleInputs.forEach((inp) => {
                if (document.activeElement === inp) return;
                const idx = Number(inp.dataset.vidTitleIndex);
                const found = vids.find((v) => v.index === idx);
                if (found && inp.value !== found.title) {
                    inp.value = found.title;
                }
            });

            if (qualitySelect.value !== state.selectedQuality) {
                qualitySelect.value = state.selectedQuality;
            }
        }
    } else {
        selectionSection.style.display = 'none';
        lastRenderedExtractSignature = null;
    }

    if (state.queue && state.queue.length > 0) {
        queueSection.style.display = 'block';
        const doneCount = state.queue.filter((i) =>
            ['done', 'skipped'].includes(i.status),
        ).length;
        queueCounter.textContent = `${doneCount} از ${state.queue.length} انجام شده`;

        queueListEl.innerHTML = '';
        state.queue.forEach((item, idx) => {
            const li = document.createElement('li');
            let badgeClass = 'b-wait';
            if (['checking', 'downloading', 'merging'].includes(item.status))
                badgeClass = 'b-active';
            else if (item.status === 'done') badgeClass = 'b-done';
            else if (item.status === 'skipped') badgeClass = 'b-skip';
            else if (['error', 'cancelled'].includes(item.status))
                badgeClass = 'b-error';

            const infoDiv = document.createElement('div');
            infoDiv.className = 'item-info';
            infoDiv.title = item.errorDetail
                ? `${item.title}\nعلت خطا: ${item.errorDetail}`
                : item.title;
            const displayTitle = item.is_single
                ? item.title
                : `${String(item.index).padStart(2, '0')} - ${item.title}`;
            const qLabel =
                item.quality === 'audio' ? 'فقط صدا' : `${item.quality}p`;

            const titleSpan = document.createElement('span');
            titleSpan.className = 'item-title';
            titleSpan.textContent = displayTitle;

            const plSpan = document.createElement('span');
            plSpan.className = 'item-pl';
            plSpan.innerHTML = ICONS.folder;
            const plText = document.createElement('span');
            plText.textContent = `${item.playlist_title} (${qLabel})`;
            plSpan.appendChild(plText);

            infoDiv.appendChild(titleSpan);
            infoDiv.appendChild(plSpan);

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'item-actions';

            const badge = document.createElement('span');
            badge.className = `badge ${badgeClass}`;
            badge.textContent = item.statusLabel;
            actionsDiv.appendChild(badge);

            if (['error', 'cancelled'].includes(item.status)) {
                const retryBtn = document.createElement('button');
                retryBtn.className = 'icon-btn retry';
                retryBtn.innerHTML = ICONS.retry;
                retryBtn.title = 'تلاش مجدد';
                retryBtn.addEventListener('click', async () => {
                    const s = await sendMsg({
                        action: 'RETRY_ITEM',
                        item_id: item.item_id,
                    });
                    renderUI(s);
                });
                actionsDiv.appendChild(retryBtn);
            }

            if (item.status === 'waiting') {
                const upBtn = document.createElement('button');
                upBtn.className = 'icon-btn';
                upBtn.innerHTML = ICONS.up;
                upBtn.title = 'انتقال به بالا';
                upBtn.disabled =
                    idx === 0 ||
                    ['checking', 'downloading', 'merging'].includes(
                        state.queue[idx - 1]?.status,
                    );
                upBtn.addEventListener('click', async () => {
                    const s = await sendMsg({
                        action: 'MOVE_QUEUE_ITEM',
                        item_id: item.item_id,
                        direction: 'up',
                    });
                    renderUI(s);
                });

                const downBtn = document.createElement('button');
                downBtn.className = 'icon-btn';
                downBtn.innerHTML = ICONS.down;
                downBtn.title = 'انتقال به پایین';
                downBtn.disabled = idx === state.queue.length - 1;
                downBtn.addEventListener('click', async () => {
                    const s = await sendMsg({
                        action: 'MOVE_QUEUE_ITEM',
                        item_id: item.item_id,
                        direction: 'down',
                    });
                    renderUI(s);
                });

                actionsDiv.appendChild(upBtn);
                actionsDiv.appendChild(downBtn);
            }

            const delBtn = document.createElement('button');
            delBtn.className = 'icon-btn del';
            delBtn.innerHTML = ICONS.close;
            delBtn.title = 'حذف از صف';
            delBtn.addEventListener('click', async () => {
                const s = await sendMsg({
                    action: 'REMOVE_QUEUE_ITEM',
                    item_id: item.item_id,
                });
                renderUI(s);
            });
            actionsDiv.appendChild(delBtn);

            li.appendChild(infoDiv);
            li.appendChild(actionsDiv);
            queueListEl.appendChild(li);
        });
    } else {
        queueSection.style.display = 'none';
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const state = await sendMsg({ action: 'GET_STATE' });

    const tabs = await queryActiveTabs();
    if (tabs[0] && tabs[0].url) {
        const parsedTab = analyzeYoutubeUrl(tabs[0].url);
        if (parsedTab.isValid) {
            urlInput.value = tabs[0].url;
        }
    }

    renderUI(state);
    if (urlInput.value.trim()) {
        updateLinkBadgeAndToggle(urlInput.value, true);
    }
});

browser.runtime.onMessage.addListener((message) => {
    if (message.action === 'STATE_UPDATED') {
        renderUI(message.state);
    }
});

urlInput.addEventListener('input', () => {
    updateLinkBadgeAndToggle(urlInput.value, true);
});

customFolderInput.addEventListener('input', () => {
    sendMsg({
        action: 'UPDATE_EXTRACTED_PLAYLIST_TITLE',
        title: customFolderInput.value,
    });
});

allowPlaylistCheckbox.addEventListener('change', async () => {
    const url = urlInput.value.trim();
    const wantPlaylist = allowPlaylistCheckbox.checked;

    if (!url) {
        const state = await sendMsg({
            action: 'SET_ALLOW_PLAYLIST',
            allowPlaylist: wantPlaylist,
        });
        renderUI(state);
        return;
    }

    const parsed = analyzeYoutubeUrl(url);

    if (!parsed.isValid) {
        triggerShake();
        const state = await sendMsg({
            action: 'SET_ALLOW_PLAYLIST',
            url,
            allowPlaylist: wantPlaylist,
            statusError: true,
            statusText:
                'لینک واردشده معتبر نیست! ابتدا یک لینک صحیح یوتیوب وارد کنید.',
        });
        renderUI(state);
        return;
    }

    if (parsed.type === 'single_only' && wantPlaylist) {
        allowPlaylistCheckbox.checked = false;
        triggerShake();
        const state = await sendMsg({
            action: 'SET_ALLOW_PLAYLIST',
            url,
            allowPlaylist: false,
            statusError: true,
            statusText:
                'این لینک فقط مربوط به یک تک‌فیلم است و پلی‌لیستی در آن وجود ندارد! تیک پلی‌لیست خاموش ماند.',
        });
        renderUI(state);
        return;
    }

    if (parsed.type === 'playlist_only' && !wantPlaylist) {
        allowPlaylistCheckbox.checked = true;
        triggerShake();
        const state = await sendMsg({
            action: 'SET_ALLOW_PLAYLIST',
            url,
            allowPlaylist: true,
            statusError: true,
            statusText:
                'این لینک مربوط به صفحه کلی پلی‌لیست است و تک‌فیلمی در آن مشخص نشده! تیک پلی‌لیست روشن ماند.',
        });
        renderUI(state);
        return;
    }

    const state = await sendMsg({
        action: 'EXTRACT_PLAYLIST',
        url,
        allowPlaylist: wantPlaylist,
    });
    renderUI(state);
});

extractBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) {
        statusBar.classList.add('error');
        statusDot.classList.add('error');
        statusEl.textContent =
            'لطفاً ابتدا لینک فیلم یا پلی‌لیست را وارد کنید.';
        return;
    }

    const parsed = analyzeYoutubeUrl(url);
    if (!parsed.isValid) {
        statusBar.classList.add('error');
        statusDot.classList.add('error');
        statusEl.textContent =
            'لینک واردشده معتبر نیست! لطفاً یک لینک صحیح یوتیوب وارد کنید.';
        return;
    }

    if (parsed.type === 'single_only' && allowPlaylistCheckbox.checked) {
        allowPlaylistCheckbox.checked = false;
    } else if (
        parsed.type === 'playlist_only' &&
        !allowPlaylistCheckbox.checked
    ) {
        allowPlaylistCheckbox.checked = true;
    }

    const state = await sendMsg({
        action: 'EXTRACT_PLAYLIST',
        url,
        allowPlaylist: allowPlaylistCheckbox.checked,
    });
    renderUI(state);
});

qualitySelect.addEventListener('change', async () => {
    const state = await sendMsg({
        action: 'SET_SELECTED_QUALITY',
        quality: qualitySelect.value,
    });
    renderUI(state);
});

selectAllCheckbox.addEventListener('change', async () => {
    const state = await sendMsg({
        action: 'SELECT_ALL_EXTRACTED',
        selectAll: selectAllCheckbox.checked,
    });
    renderUI(state);
});

enqueueBtn.addEventListener('click', async () => {
    const state = await sendMsg({
        action: 'ENQUEUE_SELECTED',
        quality: qualitySelect.value,
    });
    renderUI(state);
});

pauseResumeBtn.addEventListener('click', async () => {
    const state = await sendMsg({ action: 'PAUSE_QUEUE' });
    renderUI(state);
});

cancelCurrentBtn.addEventListener('click', async () => {
    const state = await sendMsg({
        action: 'CANCEL_CURRENT',
    });
    renderUI(state);
});

clearFinishedBtn.addEventListener('click', async () => {
    const state = await sendMsg({
        action: 'CLEAR_FINISHED',
    });
    renderUI(state);
});

clearAllBtn.addEventListener('click', async () => {
    const state = await sendMsg({
        action: 'CLEAR_ALL_QUEUE',
    });
    renderUI(state);
});
