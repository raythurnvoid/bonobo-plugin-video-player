import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BonoboFileViewContext, BonoboClient } from "bonobo-plugin-sdk/frontend";
import type { GenericId } from "convex/values";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "./app";

function make_context(): BonoboFileViewContext {
	return {
		kind: "file_view",
		pluginName: "video-player",
		fileViewId: "player",
		fileViewTitle: "Video player",
		userId: "user_1" as GenericId<"users">,
		organizationId: "org_1",
		workspaceId: "ws_1",
		file: {
			fileNodeId: "n1",
			name: "clip.mp4",
			path: "/clips/clip.mp4",
			contentType: "video/mp4",
		},
	};
}

function make_client(fetchJson: unknown): BonoboClient {
	return { fetchJson } as unknown as BonoboClient;
}

function url_response(url: string, expiresAt = Date.now() + 600_000) {
	return {
		status: 200,
		body: { items: [{ fileNodeId: "n1", url, expiresAt }], errors: [], truncated: false },
	};
}

afterEach(cleanup);

test("renders the file name and plays the context's node with one minted URL", async () => {
	const fetchJson = vi.fn(async (_path: string, body: { fileNodeIds: string[] }) => {
		expect(body.fileNodeIds).toEqual(["n1"]);
		return url_response("u1");
	});
	const { container } = render(<App client={make_client(fetchJson)} context={make_context()} />);

	expect(screen.getByRole("heading", { name: "clip.mp4" })).toBeTruthy();
	await waitFor(() => expect(container.querySelector("video")?.getAttribute("src")).toBe("u1"));
	expect(fetchJson).toHaveBeenCalledTimes(1);
});

test("a failed initial mint shows an alert whose Retry mints fresh and renders the video", async () => {
	const fetchJson = vi
		.fn()
		.mockRejectedValueOnce(Object.assign(new Error("service unavailable"), { status: 500 }))
		.mockResolvedValueOnce(url_response("u2"));
	const { container } = render(<App client={make_client(fetchJson)} context={make_context()} />);

	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("service unavailable");

	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() => expect(container.querySelector("video")?.getAttribute("src")).toBe("u2"));
	expect(screen.queryByRole("alert")).toBeNull();
});

test("video error renews once per failure episode, then offers manual Retry", async () => {
	const fetchJson = vi
		.fn()
		.mockResolvedValueOnce(url_response("u1"))
		.mockResolvedValueOnce(url_response("u2"))
		.mockResolvedValueOnce(url_response("u3"));
	const { container } = render(<App client={make_client(fetchJson)} context={make_context()} />);

	await waitFor(() => expect(container.querySelector("video")).toBeTruthy());
	const video = container.querySelector("video");
	if (!video) {
		throw new Error("video missing");
	}

	// Expired URL: a load error triggers exactly one automatic renewal.
	fireEvent.error(video);
	await waitFor(() => expect(video.getAttribute("src")).toBe("u2"));

	// The renewed URL fails too: terminal for this episode — alert + manual Retry.
	fireEvent.error(video);
	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toContain("Failed to load the video");

	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() => expect(container.querySelector("video")?.getAttribute("src")).toBe("u3"));
	expect(fetchJson).toHaveBeenCalledTimes(3);
});

test("restores time and resumes playback after renewal, surviving a rejected play()", async () => {
	const fetchJson = vi.fn().mockResolvedValueOnce(url_response("u1")).mockResolvedValueOnce(url_response("u2"));
	const play = vi.fn(() => Promise.reject(new Error("autoplay blocked")));
	const { container } = render(<App client={make_client(fetchJson)} context={make_context()} />);

	await waitFor(() => expect(container.querySelector("video")).toBeTruthy());
	const video = container.querySelector("video");
	if (!video) {
		throw new Error("video missing");
	}
	Object.defineProperty(video, "play", { value: play, configurable: true });
	Object.defineProperty(video, "currentTime", { value: 0, writable: true, configurable: true });
	Object.defineProperty(video, "paused", { get: () => false, configurable: true });

	// First load: no restore pending, so the player does not autoplay.
	fireEvent.loadedMetadata(video);
	expect(play).not.toHaveBeenCalled();

	// Mid-playback URL expiry: position/paused are captured, the URL renews, and both are
	// restored once the replacement's metadata loads.
	video.currentTime = 42;
	fireEvent.error(video);
	await waitFor(() => expect(video.getAttribute("src")).toBe("u2"));
	video.currentTime = 0; // the failed replacement load reset the position
	fireEvent.loadedMetadata(video);
	expect(video.currentTime).toBe(42);
	expect(play).toHaveBeenCalledTimes(1); // was playing → resumed; rejection swallowed
});

test("restores a paused position without resuming playback", async () => {
	const fetchJson = vi.fn().mockResolvedValueOnce(url_response("u1")).mockResolvedValueOnce(url_response("u2"));
	const play = vi.fn(() => Promise.resolve());
	const { container } = render(<App client={make_client(fetchJson)} context={make_context()} />);

	await waitFor(() => expect(container.querySelector("video")).toBeTruthy());
	const video = container.querySelector("video");
	if (!video) {
		throw new Error("video missing");
	}
	Object.defineProperty(video, "play", { value: play, configurable: true });
	Object.defineProperty(video, "currentTime", { value: 0, writable: true, configurable: true });
	Object.defineProperty(video, "paused", { get: () => true, configurable: true });

	video.currentTime = 17;
	fireEvent.error(video);
	await waitFor(() => expect(video.getAttribute("src")).toBe("u2"));
	video.currentTime = 0;
	fireEvent.loadedMetadata(video);
	expect(video.currentTime).toBe(17);
	expect(play).not.toHaveBeenCalled();
});
