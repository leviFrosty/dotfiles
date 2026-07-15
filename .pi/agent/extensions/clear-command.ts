import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Register `/clear` as a discoverable alias for starting a new session. */
export default function clearCommand(pi: ExtensionAPI): void {
	pi.registerCommand("clear", {
		description: "Clear chat history and start a new session",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
}
