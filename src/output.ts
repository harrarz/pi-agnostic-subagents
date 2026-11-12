/** Best-effort presentation only. Never used to decide a run's state/outcome. */
export function formatOutput(raw: string, maxChars = 16 * 1024): string {
	const pretty = (value: string): string => {
		try {
			const parsed: unknown = JSON.parse(value);
			return parsed !== null && typeof parsed === "object" ? JSON.stringify(parsed, null, 2) : value;
		} catch {
			// Partial tails, stderr diagnostics, and unknown formats remain intact.
			return value;
		}
	};
	const document = pretty(raw);
	const formatted = document !== raw ? document : raw.split("\n").map(pretty).join("\n");
	const marker = "\n… [formatted preview truncated; inspect the raw log]";
	return formatted.length <= maxChars ? formatted : formatted.slice(0, Math.max(0, maxChars - marker.length)) + marker.slice(0, maxChars);
}
