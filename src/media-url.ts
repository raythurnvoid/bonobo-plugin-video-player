import type { BonoboClient } from "bonobo-plugin-sdk/frontend";
import type { BonoboHttpApi, BonoboHttpResponse } from "bonobo-plugin-sdk/http-api";
import { fetch_json_with_429_retry } from "./retry";

/** Signed URLs are re-requested when they are this close to `expiresAt`. */
export const URL_EXPIRY_MARGIN_MS = 60_000;

export type MediaUrl = { url: string; expiresAt: number };

/** What `/api/v1/files/download-urls` answers on a 200, as the app's own route table declares it. */
type DownloadUrlsBody = BonoboHttpApi["/api/v1/files/download-urls"]["POST"]["response"][200]["body"];

/**
 * The 200 body, or a throw carrying the route's own refusal sentence. The caller turns it into
 * the member-visible error, and every refusal this route declares carries `message`. Since SDK
 * 0.18.0 a body that did not parse arrives as `null` on any status, so that throws here too.
 */
function download_urls_body(answer: BonoboHttpResponse<"/api/v1/files/download-urls">): DownloadUrlsBody {
	if (answer.status !== 200) {
		throw new Error(answer.body?.message ?? `The download-urls door answered ${answer.status}`);
	}
	if (answer.body === null) {
		throw new Error("The download-urls door answered 200 with a body that is not JSON");
	}
	return answer.body;
}

export type MediaUrlManager = {
	/** Returns the cached URL while it is comfortably before expiry; otherwise mints a fresh one. */
	get_url(): Promise<MediaUrl>;
	/**
	 * Post-failure renewals and manual retries: always mints a fresh URL (the cached one is
	 * demonstrably failing or near expiry) — still deduped against an in-flight request.
	 */
	get_fresh_url(): Promise<MediaUrl>;
};

/**
 * Signed download URLs for the single file this view was opened for. The gallery plugin's manager
 * batches many nodes; the player needs only its one node, so this keeps the same cache, in-flight
 * dedup, and 3s/6s 429 back-off without the batching.
 */
export function create_media_url_manager(client: BonoboClient, nodeId: string): MediaUrlManager {
	let cached: MediaUrl | null = null;
	let in_flight: Promise<MediaUrl> | null = null;

	function request_download_url(): Promise<MediaUrl> {
		if (in_flight) {
			return in_flight;
		}
		const request = (async () => {
			try {
				const response = download_urls_body(
					await fetch_json_with_429_retry(client, "/api/v1/files/download-urls", { fileNodeIds: [nodeId] }),
				);
				const item = response.items[0];
				if (!item) {
					throw new Error(response.errors[0]?.message ?? "Not found");
				}
				cached = { url: item.url, expiresAt: item.expiresAt };
				return cached;
			} finally {
				in_flight = null;
			}
		})();
		in_flight = request;
		return request;
	}

	return {
		get_url() {
			if (cached && Date.now() < cached.expiresAt - URL_EXPIRY_MARGIN_MS) {
				return Promise.resolve(cached);
			}
			return request_download_url();
		},
		get_fresh_url() {
			return request_download_url();
		},
	};
}
