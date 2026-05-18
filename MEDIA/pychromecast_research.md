# pychromecast playlist auto-advance — research report

## Root-cause hypothesis

**Your own `_cast_play_url` is the FINISHED generator. Hypothesis #1 is the cause, but only because your code, not Samsung, is triggering it.**

The Google Cast receiver fires `idle_reason='FINISHED'` whenever a media session ends *naturally* — and that includes when a **new `LOAD` message replaces the running session**. Only `INTERRUPTED`, `CANCELLED`, or `ERROR` are emitted for forcible mid-stream replacement. Empirically (and confirmed by the only reference impl, [pychromecast issue #330](https://github.com/balloob/pychromecast/issues/330)), Samsung's Default Media Receiver consistently reports `FINISHED` for any `TYPE_LOAD` that closes a session that had already entered `PLAYING`. Your `_saw_playing_for_idx == q_idx` guard is satisfied within the first 1-2 seconds of every track, so the *next* LOAD's session-teardown fires the listener and advances the queue, which calls `_cast_play_url` again, which fires the listener again — explosive auto-advance in seconds, exactly your log.

Hypothesis #4 compounds it: `mc.update_status()` from your HTTP polling thread and `block_until_active()` from the main thread share a single `socket_client` reader. The "Error reading from socket / resetting connection" at 13:40:12 is the symptom — see [HA core #54557](https://github.com/home-assistant/core/issues/54557) and [#10693](https://github.com/home-assistant/home-assistant/issues/10693). The reconnect re-registers the listener and re-replays the last status, causing another spurious FINISHED.

## Concrete fix — use the native queue

Stop sequencing tracks yourself. pychromecast supports the receiver's native queue via `play_media(..., enqueue=True)`, which sends a `TYPE_QUEUE_INSERT` with `autoplay:True` instead of a session-replacing `TYPE_LOAD`. The receiver advances tracks itself, no FINISHED handler needed.

Canonical pattern from [`examples/media_enqueue.py`](https://github.com/home-assistant-libs/pychromecast/blob/master/examples/media_enqueue.py):

```python
cast.media_controller.play_media(urls[0], "audio/mpeg", title=titles[0])
cast.media_controller.block_until_active(timeout=10)
for url, title in zip(urls[1:], titles[1:]):
    cast.media_controller.play_media(url, "audio/mpeg", title=title, enqueue=True)
```

Internals (`pychromecast/controllers/media.py` `_send_start_play_media`, ~lines 290-340): with `enqueue=True` the controller reads the live `media_session_id` and emits one `QUEUE_INSERT` per item with `{autoplay:True, preloadTime:N}` — receiver-side auto-advance, zero FINISHED listening required.

For skip/prev expose `mc.queue_next()` / `mc.queue_prev()`. Drop your `_CastStatusListener.new_media_status` FINISHED branch entirely — the only useful signal there is `load_media_failed`.

## Other answers

- **Q2 — canonical end-of-track detection:** there isn't one for sequential `play_media`. HA's [`cast/media_player.py`](https://github.com/home-assistant/core/blob/dev/homeassistant/components/cast/media_player.py) doesn't implement queues at all — it plays one item, parses only `playlist[0].url`, and relies on the user/UI for next. Music Assistant uses receiver-native queues, same as the fix above.
- **Q3 — `queue_load`:** no such method exists in pychromecast. The receiver-side primitive is `QUEUE_LOAD`; pychromecast exposes it only via `play_media(enqueue=True)` which sends `QUEUE_INSERT`.
- **Q4 — threading:** `media_controller` is **not safe** for concurrent access. Serialize all calls (`play_media`, `update_status`, `set_volume`) behind your `_cast_lock`. Cache `mc.status` server-side; let the 5 s HTTP poll read the cache, not call `update_status()`.
- **Q5 — `block_until_active`:** waits on `session_active_event` (set when `media_session_id` is not None) — i.e. **session established, NOT playback started**. Calling `set_volume` immediately after is fine (receiver-level, not session-level), but assume media has not begun.

Sources:
- [pychromecast media.py](https://github.com/home-assistant-libs/pychromecast/blob/master/pychromecast/controllers/media.py)
- [media_enqueue.py example](https://github.com/home-assistant-libs/pychromecast/blob/master/examples/media_enqueue.py)
- [Issue #330 — playlist pattern](https://github.com/balloob/pychromecast/issues/330)
- [HA core #54557 — socket heartbeat](https://github.com/home-assistant/core/issues/54557)
- [HA core #10693 — concurrent socket errors](https://github.com/home-assistant/home-assistant/issues/10693)
- [HA cast/media_player.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/cast/media_player.py)
- [Google Cast Queueing](https://developers.google.com/cast/docs/web_receiver/queueing)
