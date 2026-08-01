import { bonobo_ui_connect } from "bonobo-plugin-sdk/frontend";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./player.css";

function BootScreen(props: { message: string; isError?: boolean }) {
	return (
		<div
			className={props.isError ? "boot-screen is-error" : "boot-screen"}
			role={props.isError ? "alert" : "status"}
			aria-live={props.isError ? undefined : "polite"}
		>
			{props.message}
		</div>
	);
}

const container = document.getElementById("root");
if (!container) {
	// Unreachable: index.html always ships the #root element.
	throw new Error("index.html is missing the #root element");
}
const root = createRoot(container);
root.render(<BootScreen message="Connecting…" />);

bonobo_ui_connect().then(
	(client) => {
		const context = client.context;
		// The player only declares a file view; a page embed would be a host bug.
		if (context.kind !== "file_view") {
			root.render(<BootScreen message="This plugin only provides a file view" isError />);
			return;
		}
		document.title = `${context.fileViewTitle} — ${context.file.name}`;
		root.render(<App client={client} context={context} />);
	},
	(error: unknown) => {
		root.render(<BootScreen message={error instanceof Error ? error.message : String(error)} isError />);
	},
);
