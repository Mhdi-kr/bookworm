import { useEffect, useState } from "react";
import {
  installHelpText,
  isStandaloneDisplay,
  promptInstall,
  subscribeInstallPrompt,
} from "../lib/offline/pwa";

export function InstallApp() {
  const [standalone, setStandalone] = useState(isStandaloneDisplay);
  const [, setPromptVersion] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(display-mode: standalone)");
    const sync = () => setStandalone(isStandaloneDisplay());
    media.addEventListener("change", sync);
    const unsub = subscribeInstallPrompt(() => {
      setPromptVersion((value) => value + 1);
      sync();
    });
    return () => {
      media.removeEventListener("change", sync);
      unsub();
    };
  }, []);

  if (standalone) return null;

  async function onInstall() {
    const outcome = await promptInstall();
    if (outcome === "unavailable") setHelpOpen(true);
  }

  const help = installHelpText();

  return (
    <>
      <button
        type="button"
        onClick={() => void onInstall()}
        className="rounded-full border border-oxblood px-5 py-2.5 text-sm font-medium text-oxblood transition hover:bg-oxblood/10"
      >
        Install app
      </button>
      {helpOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="install-help-title"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-paper p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="install-help-title" className="font-serif text-2xl">
              {help.title}
            </h2>
            <p className="mt-3 text-ink-soft">{help.body}</p>
            <p className="mt-3 text-sm text-ink-soft">
              Import books once while online. After the voice model finishes downloading, reading
              aloud works without a connection.
            </p>
            <button
              type="button"
              onClick={() => setHelpOpen(false)}
              className="mt-5 rounded-full bg-oxblood px-5 py-2.5 text-sm font-medium text-sepia"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
