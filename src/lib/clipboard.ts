import { toast } from "sonner";

/** Copy text with a visible result either way; clipboard access can be denied (permissions, insecure frames). */
export async function copyText(text: string, success = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(success);
    return true;
  } catch {
    toast.error("Couldn't copy to the clipboard.", {
      description: "Select the text and copy it manually.",
    });
    return false;
  }
}
