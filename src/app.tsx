import type { BonoboUiFileViewContext, BonoboUiFrontendClient } from "bonobo-plugin-sdk/frontend";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create_media_url_manager, type MediaUrl } from "./media-url";
import { get_error_message } from "./retry";

export function App(props: { client: BonoboUiFrontendClient; context: BonoboUiFileViewContext }) {
	const media = useMemo(
		() => create_media_url_manager(props.client, props.context.file.fileNodeId),
		[props.client, props.context.file.fileNodeId],
	);
	const [mediaUrl, setMediaUrl] = useState<MediaUrl | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	// One automatic URL renewal per failure episode; reset only by a successful load or Retry.
	const autoRenewSpentRef = useRef(false);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	// Playback position captured when the video URL fails mid-session, restored onto the renewed
	// URL once its metadata loads.
	const restoreRef = useRef<{ currentTime: number; paused: boolean } | null>(null);

	const request_url = useCallback(
		(fresh: boolean) => {
			const promise = fresh ? media.get_fresh_url() : media.get_url();
			promise.then(
				(media_url) => {
					setMediaUrl(media_url);
					setErrorMessage(null);
				},
				(error: unknown) => {
					setMediaUrl(null);
					setErrorMessage(get_error_message(error));
				},
			);
		},
		[media],
	);

	useEffect(() => {
		autoRenewSpentRef.current = false;
		setMediaUrl(null);
		setErrorMessage(null);
		request_url(false);
	}, [request_url]);

	const handle_video_error = useCallback(() => {
		const video = videoRef.current;
		if (video && Number.isFinite(video.currentTime)) {
			restoreRef.current = { currentTime: video.currentTime, paused: video.paused };
		}
		if (autoRenewSpentRef.current) {
			// The renewed URL failed to load too — stop and offer manual Retry.
			setMediaUrl(null);
			setErrorMessage("Failed to load the video");
			return;
		}
		autoRenewSpentRef.current = true;
		request_url(true);
	}, [request_url]);

	const handle_video_loaded_metadata = useCallback(() => {
		autoRenewSpentRef.current = false;
		const video = videoRef.current;
		if (!video) {
			return;
		}
		const restore = restoreRef.current;
		restoreRef.current = null;
		if (restore) {
			video.currentTime = restore.currentTime;
			if (!restore.paused) {
				// Autoplay of the renewed URL may be blocked; the user still has controls.
				video.play().catch(() => {});
			}
		}
	}, []);

	const handle_retry = useCallback(() => {
		autoRenewSpentRef.current = false;
		setErrorMessage(null);
		request_url(true);
	}, [request_url]);

	return (
		<div className="player">
			<header className="player-header">
				<h1 className="player-name">{props.context.file.name}</h1>
				<div className="player-meta">{props.context.file.path}</div>
			</header>
			<div className="player-stage">
				{errorMessage !== null ? (
					<div className="player-status is-error" role="alert">
						<span>{errorMessage}</span>
						<button className="button" onClick={handle_retry}>
							Retry
						</button>
					</div>
				) : mediaUrl === null ? (
					<div className="player-status" role="status" aria-live="polite">
						Loading…
					</div>
				) : (
					<video
						ref={videoRef}
						className="player-video"
						src={mediaUrl.url}
						controls
						onLoadedMetadata={handle_video_loaded_metadata}
						onError={handle_video_error}
					/>
				)}
			</div>
		</div>
	);
}
