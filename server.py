from flask import Flask, request, jsonify
from flask_cors import CORS
from urllib.parse import urlparse, parse_qs
import yt_dlp
import os
import re
import subprocess
import threading
import time

app = Flask(__name__)
CORS(app)


import os

# شناسایی خودکار پوشه Downloads در ویندوز یا سایر سیستم‌عامل‌ها
user_home = os.path.expanduser("~")
DOWNLOAD_FOLDER = os.path.join(user_home, "Downloads", "YouTube_Downloads")
# ایجاد پوشه در صورت عدم وجود
os.makedirs(DOWNLOAD_FOLDER, exist_ok=True)


# DOWNLOAD_FOLDER = os.path.join(os.getcwd(), "YouTube_Downloads")
# os.makedirs(DOWNLOAD_FOLDER, exist_ok=True)


class DownloadAbortException(Exception):
    pass


current_job = {
    "active": False,
    "item_id": None,
    "status": "idle",
    "percent": 0.0,
    "downloaded": "0 B",
    "total": "0 B",
    "speed": "0 B/s",
    "eta": "--:--",
    "message": "",
    "error": None,
    "abort_action": None,
}
job_lock = threading.Lock()

DEFAULT_QUALITIES = [
    {"value": "1080", "label": "1080p (Full HD)"},
    {"value": "720", "label": "720p (HD)"},
    {"value": "480", "label": "480p"},
    {"value": "360", "label": "360p"},
    {"value": "audio", "label": "فقط صدا (M4A/MP3)"},
]

WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
}


def sanitize_name(name, max_len=110):
    if not name:
        return "Untitled"
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(name))
    cleaned = re.sub(r"\s+", " ", cleaned).strip().rstrip(". ")
    if len(cleaned) > max_len:
        cleaned = cleaned[:max_len].rstrip(". ")
    if not cleaned:
        return "Untitled"
    if cleaned.upper() in WINDOWS_RESERVED_NAMES:
        cleaned = f"_{cleaned}"
    return cleaned


def strip_ansi(text):
    if not text:
        return ""
    return re.sub(r"\x1b\[[0-9;]*m", "", str(text)).strip()


def format_bytes(b):
    if not b or b <= 0:
        return "0 B"
    for unit in ["B", "KB", "MB", "GB"]:
        if b < 1024.0:
            return f"{b:.1f} {unit}"
        b /= 1024.0
    return f"{b:.1f} TB"


def parse_youtube_url(url):
    """
    تحلیل دقیق تمام فرمت‌های لینک یوتیوب:
    - watch?v=ID
    - watch?v=ID&list=LIST_ID&index=N
    - youtu.be/ID یا youtu.be/ID?list=LIST_ID
    - youtube.com/shorts/ID یا youtube.com/live/ID یا youtube.com/embed/ID
    - youtube.com/playlist?list=LIST_ID
    """
    result = {
        "is_valid": False,
        "type": "invalid",  # 'single_only' | 'both' | 'playlist_only' | 'invalid'
        "video_id": None,
        "list_id": None,
        "single_url": None,
        "playlist_url": None,
    }
    if not url or not isinstance(url, str):
        return result

    raw = url.strip()
    if not re.match(r"^https?://", raw, re.I):
        raw = "https://" + raw

    try:
        parsed = urlparse(raw)
        host = (parsed.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]

        valid_hosts = {
            "youtube.com",
            "m.youtube.com",
            "music.youtube.com",
            "gaming.youtube.com",
            "youtu.be",
            "youtube-nocookie.com",
        }
        if host not in valid_hosts:
            return result

        qs = parse_qs(parsed.query)
        path_parts = [p for p in parsed.path.split("/") if p]

        raw_vid = None
        raw_list = (qs.get("list") or [None])[0]

        if host == "youtu.be":
            if path_parts:
                raw_vid = path_parts[0]
        else:
            if "v" in qs and qs["v"]:
                raw_vid = qs["v"][0]
            elif len(path_parts) >= 2 and path_parts[0] in (
                "shorts",
                "live",
                "embed",
                "v",
                "e",
            ):
                if path_parts[1] != "videoseries":
                    raw_vid = path_parts[1]

        video_id = (
            raw_vid.strip() if isinstance(raw_vid, str) and raw_vid.strip() else None
        )
        list_id = (
            raw_list.strip() if isinstance(raw_list, str) and raw_list.strip() else None
        )

        if video_id and list_id:
            url_type = "both"
        elif video_id:
            url_type = "single_only"
        elif list_id:
            url_type = "playlist_only"
        else:
            return result

        single_url = f"https://www.youtube.com/watch?v={video_id}" if video_id else None

        playlist_url = None
        if list_id:
            if list_id.upper().startswith("RD") and video_id:
                playlist_url = (
                    f"https://www.youtube.com/watch?v={video_id}&list={list_id}"
                )
            else:
                playlist_url = f"https://www.youtube.com/playlist?list={list_id}"

        result.update(
            {
                "is_valid": True,
                "type": url_type,
                "video_id": video_id,
                "list_id": list_id,
                "single_url": single_url,
                "playlist_url": playlist_url,
            }
        )
        return result
    except Exception:
        return result


def build_base_stem(index, safe_title, is_single=False, quality="720"):
    suffix = " [Audio]" if str(quality) == "audio" else ""
    if is_single:
        return f"{safe_title}{suffix}"
    return f"{int(index):02d} - {safe_title}{suffix}"


def extract_available_qualities(video_info):
    if not video_info:
        return DEFAULT_QUALITIES

    formats = video_info.get("formats") or []
    heights = {}
    best_audio_size = 0

    for f in formats:
        vcodec = f.get("vcodec") or "none"
        acodec = f.get("acodec") or "none"
        size = f.get("filesize") or f.get("filesize_approx") or 0

        if vcodec == "none" and acodec != "none":
            if size > best_audio_size:
                best_audio_size = size

        height = f.get("height")
        if height and isinstance(height, int) and height >= 144 and vcodec != "none":
            fps = f.get("fps") or 30
            if height not in heights:
                heights[height] = {"max_size": size, "fps": fps}
            else:
                if size > heights[height]["max_size"]:
                    heights[height]["max_size"] = size
                if fps and fps > heights[height]["fps"]:
                    heights[height]["fps"] = fps

    if not heights:
        for f in formats:
            height = f.get("height")
            if height and isinstance(height, int) and height >= 144:
                size = f.get("filesize") or f.get("filesize_approx") or 0
                fps = f.get("fps") or 30
                if height not in heights:
                    heights[height] = {"max_size": size, "fps": fps}

    qualities = []
    for h in sorted(heights.keys(), reverse=True):
        info = heights[h]
        fps_str = f" {int(info['fps'])}fps" if info["fps"] and info["fps"] > 30 else ""

        res_badge = ""
        if h >= 2160:
            res_badge = " (4K)"
        elif h >= 1440:
            res_badge = " (2K)"
        elif h == 1080:
            res_badge = " (Full HD)"
        elif h == 720:
            res_badge = " (HD)"

        size_str = ""
        if info["max_size"] > 0:
            total_est = info["max_size"] + best_audio_size
            size_str = f" ~ {format_bytes(total_est)}"

        qualities.append(
            {"value": str(h), "label": f"{h}p{res_badge}{fps_str}{size_str}"}
        )

    if not qualities:
        return DEFAULT_QUALITIES

    audio_size_str = (
        f" (~ {format_bytes(best_audio_size)})" if best_audio_size > 0 else ""
    )
    qualities.append(
        {"value": "audio", "label": f"فقط صدا - بهینه (M4A/MP3){audio_size_str}"}
    )

    return qualities


def get_local_video_duration(filepath):
    try:
        cmd = [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            filepath,
        ]
        creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        output = subprocess.check_output(
            cmd, stderr=subprocess.STDOUT, timeout=5, creationflags=creationflags
        )
        return float(output.decode("utf-8").strip())
    except Exception:
        return None


def is_temp_download_file(fname):
    lower = fname.lower()
    if lower.endswith((".part", ".ytdl", ".temp")):
        return True
    if ".part-frag" in lower or ".temp." in lower:
        return True
    if re.search(r"\.f\d+\.", lower):
        return True
    return False


def cleanup_partial_files(
    playlist_folder,
    index,
    is_single=False,
    safe_title="",
    quality="720",
    remove_all_matching=False,
):
    if not os.path.exists(playlist_folder) or not safe_title:
        return

    base_stem = build_base_stem(index, safe_title, is_single, quality)
    target_prefix = f"{base_stem}.".lower()

    for attempt in range(3):
        time.sleep(0.25)
        pending_retry = False
        try:
            filenames = os.listdir(playlist_folder)
        except OSError:
            break

        for fname in filenames:
            if fname.lower().startswith(target_prefix):
                fpath = os.path.join(playlist_folder, fname)
                is_temp = is_temp_download_file(fname)
                try:
                    is_empty = os.path.isfile(fpath) and os.path.getsize(fpath) == 0
                    if is_temp or is_empty or remove_all_matching:
                        os.remove(fpath)
                except OSError:
                    pending_retry = True
        if not pending_retry:
            break


def check_already_downloaded(
    playlist_folder, index, title, expected_duration, is_single=False, quality="720"
):
    if not os.path.exists(playlist_folder):
        return False, None

    safe_title = sanitize_name(title)
    expected_stem = build_base_stem(index, safe_title, is_single, quality).lower()
    legacy_stem = (
        safe_title.lower() if is_single else f"{int(index):02d} - {safe_title}".lower()
    )

    valid_exts = (
        [".m4a", ".mp3", ".opus", ".ogg", ".aac", ".webm"]
        if str(quality) == "audio"
        else [".mp4", ".mkv", ".webm"]
    )

    for fname in os.listdir(playlist_folder):
        if is_temp_download_file(fname):
            continue

        name_without_ext, ext = os.path.splitext(fname)
        ext_lower = ext.lower()
        if ext_lower not in valid_exts:
            continue

        stem_lower = name_without_ext.lower()
        if str(quality) != "audio" and stem_lower.endswith(" [audio]"):
            continue
        if (
            str(quality) == "audio"
            and ext_lower == ".webm"
            and not stem_lower.endswith(" [audio]")
        ):
            continue

        is_exact_match = (
            (stem_lower == expected_stem)
            or (str(quality) != "audio" and stem_lower == legacy_stem)
            or (
                str(quality) == "audio"
                and ext_lower in [".m4a", ".mp3", ".opus", ".ogg", ".aac"]
                and stem_lower == legacy_stem
            )
        )

        if is_exact_match:
            fpath = os.path.join(playlist_folder, fname)
            try:
                file_size = os.path.getsize(fpath)
                if file_size == 0:
                    try:
                        os.remove(fpath)
                    except OSError:
                        pass
                    continue

                if expected_duration and expected_duration > 0:
                    local_dur = get_local_video_duration(fpath)
                    if local_dur is not None:
                        if abs(local_dur - expected_duration) <= 8.0:
                            return True, fname
                        else:
                            try:
                                os.remove(fpath)
                            except OSError:
                                pass
                            continue

                if file_size < 10 * 1024:
                    continue
                return True, fname
            except OSError:
                continue

    return False, None


@app.route("/extract", methods=["POST"])
def extract_url():
    data = request.get_json(silent=True) or {}
    raw_url = data.get("url", "").strip()
    allow_playlist = bool(data.get("allow_playlist", False))

    if not raw_url:
        return jsonify({"error": "لینک وارد نشده است."}), 400

    parsed_info = parse_youtube_url(raw_url)
    if not parsed_info["is_valid"]:
        return (
            jsonify(
                {
                    "error": "لینک یوتیوب معتبر نیست! لطفاً لینک صحیح تک‌فیلم یا پلی‌لیست وارد کنید."
                }
            ),
            400,
        )

    url_type = parsed_info["type"]

    if url_type == "single_only" and allow_playlist:
        return (
            jsonify(
                {
                    "error": "این لینک فقط مربوط به یک تک‌فیلم است و پلی‌لیستی در آن وجود ندارد! تیک پلی‌لیست خاموش ماند.",
                    "force_allow_playlist": False,
                    "url_type": url_type,
                }
            ),
            400,
        )

    if url_type == "playlist_only" and not allow_playlist:
        return (
            jsonify(
                {
                    "error": "این لینک مربوط به صفحه کلی پلی‌لیست است و تک‌فیلمی در آن مشخص نشده! تیک پلی‌لیست باید روشن باشد.",
                    "force_allow_playlist": True,
                    "url_type": url_type,
                }
            ),
            400,
        )

    extract_as_playlist = allow_playlist and url_type in ("playlist_only", "both")

    try:
        if not extract_as_playlist:
            target_url = parsed_info["single_url"]
            single_opts = {
                "extract_flat": False,
                "noplaylist": True,
                "quiet": True,
                "no_warnings": True,
            }
            with yt_dlp.YoutubeDL(single_opts) as ydl:
                info = ydl.extract_info(target_url, download=False)
                if not info:
                    return jsonify({"error": "اطلاعاتی از این ویدیو دریافت نشد."}), 400

                if "entries" in info:
                    entries = [e for e in (info.get("entries") or []) if e]
                    if not entries:
                        return jsonify({"error": "ویدیویی پیدا نشد."}), 400
                    info = entries[0]

                qualities = extract_available_qualities(info)
                vid_url = info.get("webpage_url") or target_url
                videos = [
                    {
                        "index": 1,
                        "title": info.get("title", "Single Video"),
                        "url": vid_url,
                        "duration": info.get("duration") or 0,
                        "is_single": True,
                    }
                ]
                print(
                    f"[Extract Single] ({url_type}) Found {len(qualities)} qualities for: {videos[0]['title']}"
                )
                return jsonify(
                    {
                        "is_playlist": False,
                        "url_type": url_type,
                        "resolved_url": target_url,
                        "playlist_title": "Single_Videos",
                        "videos": videos,
                        "qualities": qualities,
                    }
                )

        else:
            target_url = parsed_info["playlist_url"]
            list_id = parsed_info.get("list_id") or ""
            pl_opts = {
                "extract_flat": "in_playlist",
                "noplaylist": False,
                "quiet": True,
                "no_warnings": True,
                "ignoreerrors": True,
            }
            if list_id.upper().startswith("RD"):
                pl_opts["playlistend"] = 50

            with yt_dlp.YoutubeDL(pl_opts) as ydl:
                info = ydl.extract_info(target_url, download=False)
                if not info:
                    return (
                        jsonify({"error": "اطلاعاتی از این پلی‌لیست دریافت نشد."}),
                        400,
                    )

                if "entries" not in info:
                    qualities = extract_available_qualities(info)
                    videos = [
                        {
                            "index": 1,
                            "title": info.get("title", "Single Video"),
                            "url": info.get("webpage_url") or target_url,
                            "duration": info.get("duration") or 0,
                            "is_single": True,
                        }
                    ]
                    return jsonify(
                        {
                            "is_playlist": False,
                            "url_type": url_type,
                            "resolved_url": target_url,
                            "playlist_title": "Single_Videos",
                            "videos": videos,
                            "qualities": qualities,
                        }
                    )

                playlist_title = sanitize_name(info.get("title") or "YouTube_Playlist")
                videos = []
                entries = list(info.get("entries") or [])
                used_indices = set()

                for idx, entry in enumerate(entries, start=1):
                    if not entry:
                        continue
                    vid_id = entry.get("id")
                    vid_title = entry.get("title")
                    if not vid_id or vid_title in [
                        "[Private video]",
                        "[Deleted video]",
                        "[Unavailable video]",
                    ]:
                        continue

                    real_index = int(entry.get("playlist_index") or idx)
                    while real_index in used_indices:
                        real_index += 1
                    used_indices.add(real_index)

                    vid_url = f"https://www.youtube.com/watch?v={vid_id}"
                    videos.append(
                        {
                            "index": real_index,
                            "title": vid_title or f"Video {real_index}",
                            "url": vid_url,
                            "duration": entry.get("duration") or 0,
                            "is_single": False,
                        }
                    )

                if not videos:
                    return (
                        jsonify(
                            {
                                "error": "هیچ ویدیوی قابل دانلودی در این پلی‌لیست پیدا نشد."
                            }
                        ),
                        400,
                    )

                qualities = []
                try:
                    sample_opts = {
                        "extract_flat": False,
                        "noplaylist": True,
                        "quiet": True,
                        "no_warnings": True,
                    }
                    with yt_dlp.YoutubeDL(sample_opts) as ydl_sample:
                        sample_info = ydl_sample.extract_info(
                            videos[0]["url"], download=False
                        )
                        if sample_info:
                            qualities = extract_available_qualities(sample_info)
                            for q in qualities:
                                q["label"] = q["label"].split(" ~ ")[0]
                except Exception as e:
                    print(f"[Sample Quality Warning] {e}")

                if not qualities:
                    qualities = DEFAULT_QUALITIES

                print(
                    f"[Extract Playlist] ({url_type} -> {target_url}) Found {len(videos)} videos and {len(qualities)} qualities."
                )
                return jsonify(
                    {
                        "is_playlist": True,
                        "url_type": url_type,
                        "resolved_url": target_url,
                        "playlist_title": playlist_title,
                        "videos": videos,
                        "qualities": qualities,
                    }
                )

    except Exception as e:
        print(f"[Extract Error] {e}")
        return jsonify({"error": str(e)}), 500


def run_yt_dlp_download(
    video_url, output_template, quality, progress_hook, allow_resume=True
):
    if str(quality) == "audio":
        fmt = "bestaudio[ext=m4a]/bestaudio/best"
        merge_fmt = None
    else:
        fmt = (
            f"bestvideo[height<={quality}][ext=mp4]+bestaudio[ext=m4a]/"
            f"bestvideo[height<={quality}]+bestaudio[ext=m4a]/"
            f"bestvideo[height<={quality}]+bestaudio/"
            f"best[height<={quality}]/best"
        )
        merge_fmt = "mp4"

    ydl_opts = {
        "format": fmt,
        "outtmpl": output_template,
        "noplaylist": True,
        "continuedl": allow_resume,
        "overwrites": not allow_resume,
        "retries": 10,
        "fragment_retries": 10,
        "progress_hooks": [progress_hook],
        "quiet": False,
    }
    if merge_fmt:
        ydl_opts["merge_output_format"] = merge_fmt

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([video_url])


def download_worker(item):
    video_url = item.get("url")
    title = item.get("title", "Video")
    index = int(item.get("index", 1))
    quality = str(item.get("quality", "720"))
    playlist_title = sanitize_name(item.get("playlist_title") or "Single_Videos")
    expected_duration = item.get("duration") or 0
    is_single = bool(item.get("is_single", False))

    playlist_folder = os.path.join(DOWNLOAD_FOLDER, playlist_title)
    os.makedirs(playlist_folder, exist_ok=True)
    safe_video_title = sanitize_name(title)
    base_stem = build_base_stem(index, safe_video_title, is_single, quality)

    try:
        exists, existing_file = check_already_downloaded(
            playlist_folder, index, title, expected_duration, is_single, quality
        )
        if exists:
            with job_lock:
                current_job.update(
                    {
                        "active": False,
                        "status": "skipped",
                        "percent": 100.0,
                        "message": f"از قبل موجود است ({existing_file})",
                    }
                )
            return

        if not expected_duration:
            try:
                with yt_dlp.YoutubeDL(
                    {"quiet": True, "no_warnings": True, "noplaylist": True}
                ) as ydl_info:
                    vid_info = ydl_info.extract_info(video_url, download=False)
                    if vid_info:
                        expected_duration = vid_info.get("duration") or 0
                        exists, existing_file = check_already_downloaded(
                            playlist_folder,
                            index,
                            title,
                            expected_duration,
                            is_single,
                            quality,
                        )
                        if exists:
                            with job_lock:
                                current_job.update(
                                    {
                                        "active": False,
                                        "status": "skipped",
                                        "percent": 100.0,
                                        "message": f"از قبل موجود است ({existing_file})",
                                    }
                                )
                            return
            except Exception:
                pass

        with job_lock:
            if current_job["abort_action"]:
                raise DownloadAbortException(current_job["abort_action"])

        def progress_hook(d):
            with job_lock:
                if current_job["abort_action"]:
                    raise DownloadAbortException(current_job["abort_action"])

            if d["status"] == "downloading":
                total_bytes = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                downloaded_bytes = d.get("downloaded_bytes", 0)

                if total_bytes > 0:
                    pct = (downloaded_bytes / total_bytes) * 100.0
                else:
                    pct_str = strip_ansi(d.get("_percent_str", "0%")).replace("%", "")
                    try:
                        pct = float(pct_str)
                    except ValueError:
                        pct = 0.0

                speed_str = strip_ansi(d.get("_speed_str", "0 B/s"))
                eta_str = strip_ansi(d.get("_eta_str", "--:--"))

                with job_lock:
                    current_job.update(
                        {
                            "status": "downloading",
                            "percent": round(pct, 1),
                            "downloaded": format_bytes(downloaded_bytes),
                            "total": (
                                format_bytes(total_bytes)
                                if total_bytes > 0
                                else "نامشخص"
                            ),
                            "speed": speed_str,
                            "eta": eta_str,
                            "message": "در حال دانلود...",
                        }
                    )
            elif d["status"] == "finished":
                with job_lock:
                    current_job.update(
                        {
                            "status": "merging",
                            "percent": 100.0,
                            "eta": "00:00",
                            "message": "در حال نهایی‌سازی فایل...",
                        }
                    )

        output_template = os.path.join(playlist_folder, f"{base_stem}.%(ext)s")

        try:
            run_yt_dlp_download(
                video_url, output_template, quality, progress_hook, allow_resume=True
            )
        except DownloadAbortException:
            raise
        except Exception as first_err:
            print(f"[Resume Failed] Retrying from scratch: {first_err}")
            with job_lock:
                if current_job["abort_action"]:
                    raise DownloadAbortException(current_job["abort_action"])
                current_job.update(
                    {
                        "percent": 0.0,
                        "message": "پاک‌سازی فایل ناقص قبلی و شروع مجدد...",
                    }
                )
            cleanup_partial_files(
                playlist_folder, index, is_single, safe_video_title, quality
            )
            run_yt_dlp_download(
                video_url, output_template, quality, progress_hook, allow_resume=False
            )

        with job_lock:
            if current_job["abort_action"] == "cancel":
                raise DownloadAbortException("cancel")

            current_job.update(
                {
                    "active": False,
                    "status": "completed",
                    "percent": 100.0,
                    "message": "تکمیل شد ✓",
                }
            )

    except DownloadAbortException as abort_err:
        action_type = str(abort_err)
        if action_type == "cancel":
            cleanup_partial_files(
                playlist_folder,
                index,
                is_single,
                safe_video_title,
                quality,
                remove_all_matching=True,
            )
            with job_lock:
                current_job.update(
                    {
                        "active": False,
                        "status": "cancelled",
                        "speed": "0 B/s",
                        "eta": "--:--",
                        "message": "لغو شد ✕",
                    }
                )
        else:
            with job_lock:
                current_job.update(
                    {
                        "active": False,
                        "status": "paused",
                        "speed": "0 B/s",
                        "eta": "--:--",
                        "message": "متوقف شده (قابلیت ادامه)",
                    }
                )

    except Exception as e:
        with job_lock:
            abort_act = current_job.get("abort_action")

        if abort_act == "cancel":
            cleanup_partial_files(
                playlist_folder,
                index,
                is_single,
                safe_video_title,
                quality,
                remove_all_matching=True,
            )
            with job_lock:
                current_job.update(
                    {"active": False, "status": "cancelled", "message": "لغو شد ✕"}
                )
        elif abort_act == "pause":
            with job_lock:
                current_job.update(
                    {"active": False, "status": "paused", "message": "متوقف شده"}
                )
        else:
            with job_lock:
                current_job.update(
                    {
                        "active": False,
                        "status": "error",
                        "error": str(e),
                        "message": f"خطا: {str(e)[:60]}",
                    }
                )
    finally:
        with job_lock:
            current_job["active"] = False


@app.route("/start_download", methods=["POST"])
def start_download():
    data = request.get_json(silent=True) or {}
    with job_lock:
        if current_job["active"]:
            return (
                jsonify(
                    {
                        "started": False,
                        "error": "Busy",
                        "active_item_id": current_job.get("item_id"),
                    }
                ),
                409,
            )

        current_job.update(
            {
                "active": True,
                "item_id": data.get("item_id"),
                "status": "checking",
                "percent": 0.0,
                "downloaded": "0 B",
                "total": "...",
                "speed": "0 B/s",
                "eta": "--:--",
                "message": "در حال بررسی پوشه...",
                "error": None,
                "abort_action": None,
            }
        )

    thread = threading.Thread(target=download_worker, args=(data,), daemon=True)
    thread.start()
    return jsonify({"started": True})


@app.route("/control", methods=["POST"])
def control_download():
    data = request.get_json(silent=True) or {}
    action = data.get("action")
    with job_lock:
        if current_job["active"]:
            current_job["abort_action"] = action
            return jsonify({"success": True, "action": action})
    return jsonify({"success": False, "message": "دانلود فعالی وجود ندارد."})


@app.route("/cleanup_item", methods=["POST"])
def cleanup_item():
    data = request.get_json(silent=True) or {}
    title = data.get("title", "Video")
    index = int(data.get("index", 1))
    is_single = bool(data.get("is_single", False))
    quality = str(data.get("quality", "720"))
    playlist_title = sanitize_name(data.get("playlist_title") or "Single_Videos")
    playlist_folder = os.path.join(DOWNLOAD_FOLDER, playlist_title)
    safe_video_title = sanitize_name(title)

    cleanup_partial_files(playlist_folder, index, is_single, safe_video_title, quality)
    return jsonify({"success": True})


@app.route("/progress", methods=["GET"])
def get_progress():
    with job_lock:
        return jsonify(current_job)


if __name__ == "__main__":
    print(f"Server is running! Videos will be saved inside: {DOWNLOAD_FOLDER}")
    app.run(host="127.0.0.1", port=5000, threaded=True)
