import type { BonoboClient } from "bonobo-plugin-sdk/frontend";
import { afterEach, expect, test, vi } from "vitest";
import { create_media_url_manager, URL_EXPIRY_MARGIN_MS } from "./media-url";

type Deferred = {
	promise: Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
};

function deferred(): Deferred {
	let resolve_fn: ((value: unknown) => void) | undefined;
	let reject_fn: ((error: unknown) => void) | undefined;
	const promise = new Promise<unknown>((resolve, reject) => {
		resolve_fn = resolve;
		reject_fn = reject;
	});
	return {
		promise,
		resolve: (value) => resolve_fn?.(value),
		reject: (error) => reject_fn?.(error),
	};
}

function download_url_response(nodeId: string, url: string, expiresAt: number) {
	return {
		status: 200,
		body: { items: [{ fileNodeId: nodeId, url, expiresAt }], errors: [], truncated: false },
	};
}

function make_manager(nodeId = "n1") {
	const calls: Array<{ path: string; body: { fileNodeIds: string[] }; gate: Deferred }> = [];
	const fetchJson = vi.fn((path: string, body: { fileNodeIds: string[] }) => {
		const gate = deferred();
		calls.push({ path, body, gate });
		return gate.promise;
	});
	const media = create_media_url_manager({ fetchJson } as unknown as BonoboClient, nodeId);
	return { media, fetchJson, calls };
}

afterEach(() => {
	vi.useRealTimers();
});

test("get_url requests once, caches, and reuses the URL before the expiry margin", async () => {
	const { media, fetchJson, calls } = make_manager();

	const first = media.get_url();
	calls[0].gate.resolve(download_url_response("n1", "u-1", Date.now() + 600_000));
	expect((await first).url).toBe("u-1");
	expect(calls[0].path).toBe("/api/v1/files/download-urls");
	expect(calls[0].body.fileNodeIds).toEqual(["n1"]);

	// Cached and comfortably before expiry: no second request.
	expect((await media.get_url()).url).toBe("u-1");
	expect(fetchJson).toHaveBeenCalledTimes(1);
});

test("get_url renews a URL inside the expiry margin", async () => {
	const { media, fetchJson, calls } = make_manager();

	const first = media.get_url();
	calls[0].gate.resolve(download_url_response("n1", "u-1", Date.now() + URL_EXPIRY_MARGIN_MS / 2));
	await first;

	const second = media.get_url();
	expect(fetchJson).toHaveBeenCalledTimes(2);
	calls[1].gate.resolve(download_url_response("n1", "u-2", Date.now() + 600_000));
	expect((await second).url).toBe("u-2");
});

test("get_fresh_url always requests but dedupes against the in-flight request", async () => {
	const { media, fetchJson, calls } = make_manager();

	const first = media.get_url();
	calls[0].gate.resolve(download_url_response("n1", "u-1", Date.now() + 600_000));
	await first;

	// Fresh mints even though the cached URL is still valid.
	const fresh = media.get_fresh_url();
	const duplicate = media.get_fresh_url();
	expect(fetchJson).toHaveBeenCalledTimes(2);
	calls[1].gate.resolve(download_url_response("n1", "u-2", Date.now() + 600_000));
	expect((await fresh).url).toBe("u-2");
	expect((await duplicate).url).toBe("u-2");

	// The fresh URL replaced the cache.
	expect((await media.get_url()).url).toBe("u-2");
	expect(fetchJson).toHaveBeenCalledTimes(2);
});

test("a failed request rejects with the server's per-file error and allows a retry", async () => {
	const { media, fetchJson, calls } = make_manager();

	const first = media.get_url();
	calls[0].gate.resolve({
		status: 200,
		body: { items: [], errors: [{ fileNodeId: "n1", message: "Permission denied" }], truncated: false },
	});
	await expect(first).rejects.toThrow("Permission denied");

	const retry = media.get_fresh_url();
	expect(fetchJson).toHaveBeenCalledTimes(2);
	calls[1].gate.resolve(download_url_response("n1", "u-2", Date.now() + 600_000));
	expect((await retry).url).toBe("u-2");
});

test("retries the same request after a 429 with the shared back-off", async () => {
	vi.useFakeTimers();
	const { media, fetchJson, calls } = make_manager();

	const first = media.get_url();
	// A declared 429 is an answer now; the shared back-off reads it and retries the same node.
	calls[0].gate.resolve({ status: 429, body: { message: "rate limited", retryAfterMs: 1_000 } });
	await vi.advanceTimersByTimeAsync(3_000);
	expect(fetchJson).toHaveBeenCalledTimes(2);
	expect(calls[1].body.fileNodeIds).toEqual(["n1"]);

	calls[1].gate.resolve(download_url_response("n1", "u-1", Date.now() + 600_000));
	expect((await first).url).toBe("u-1");
});

test("a refused request rejects with the route's own sentence and allows a retry", async () => {
	const { media, fetchJson, calls } = make_manager();

	const refused = media.get_url();
	// A declared refusal resolves now. Without reading the status the manager would take the
	// refusal body for a 200 and report "Not found" instead of what the route said.
	calls[0].gate.resolve({ status: 403, body: { message: "Permission denied" } });
	await expect(refused).rejects.toThrow("Permission denied");

	const retry = media.get_fresh_url();
	expect(fetchJson).toHaveBeenCalledTimes(2);
	calls[1].gate.resolve(download_url_response("n1", "u-2", Date.now() + 600_000));
	expect((await retry).url).toBe("u-2");
});
