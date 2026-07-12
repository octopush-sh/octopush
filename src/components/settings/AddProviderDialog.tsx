// Add a provider — a two-step ModalShell wizard (1 · 2). Step 1 is identity
// (name, protocol, local); step 2 is the endpoint. Replaces the inline form and
// its native <select>/<checkbox> with Atelier controls.
import { useState } from "react";
import type { ProviderConfig } from "../../lib/types";
import { ModalShell } from "../ModalShell";
import { Listbox } from "../controls/Listbox";
import { TogglePill } from "../controls/TogglePill";

type Protocol = "anthropic" | "openai-compatible";

export function AddProviderDialog({
  existingNames,
  onAdd,
  onClose,
}: {
  existingNames: string[];
  onAdd: (p: ProviderConfig) => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<Protocol>("anthropic");
  const [local, setLocal] = useState(false);
  const [baseUrl, setBaseUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const taken = new Set(existingNames.map((n) => n.toLowerCase()));

  function next() {
    const trimmed = name.trim();
    if (!trimmed) {
      setErr("Name is required");
      return;
    }
    if (taken.has(trimmed.toLowerCase())) {
      setErr("A provider with that name already exists");
      return;
    }
    setErr(null);
    // Local providers need no endpoint step — finish immediately.
    if (local) {
      finish();
      return;
    }
    setStep(2);
  }

  function finish() {
    const trimmed = name.trim();
    if (!local && !baseUrl.trim()) {
      setErr("Base URL is required");
      return;
    }
    onAdd({
      name: trimmed,
      apiBase: baseUrl.trim(),
      apiKeyEnv: "",
      models: [],
      rateLimits: {},
      enabled: true,
      protocol,
      local,
    });
  }

  return (
    <ModalShell onClose={onClose} ariaLabel="Add a provider">
      <div className="w-[400px] rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl">
        <div className="mb-4 flex items-baseline justify-between">
          <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">New provider</div>
          <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
            <span className={step === 1 ? "text-octo-brass" : ""}>1</span>
            {!local && <> · <span className={step === 2 ? "text-octo-brass" : ""}>2</span></>}
          </div>
        </div>

        {step === 1 ? (
          <div className="space-y-3">
            <div>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">Name</div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. my-gateway"
                autoFocus
                className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
              />
            </div>
            <div>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">Protocol</div>
              <Listbox
                ariaLabel="Protocol"
                className="w-full"
                value={protocol}
                onChange={(v) => setProtocol(v as Protocol)}
                options={[
                  { value: "anthropic", label: "Anthropic-compatible" },
                  { value: "openai-compatible", label: "OpenAI-compatible" },
                ]}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2">
              <span className="text-[12px] text-octo-sage">Runs locally (no API key needed)</span>
              <TogglePill on={local} onChange={setLocal} label={local ? "Local" : "Cloud"} ariaLabel="Runs locally" />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">Base URL</div>
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://my-gateway.example.com"
                autoFocus
                className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
              />
            </div>
          </div>
        )}

        {err && <div className="mt-3 font-mono text-[10px] text-octo-rouge">{err}</div>}

        <div className="mt-5 flex items-center gap-3">
          {step === 2 && (
            <button
              type="button"
              onClick={() => { setErr(null); setStep(1); }}
              className="text-[12px] text-octo-mute transition hover:text-octo-sage"
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={step === 1 ? next : finish}
            className="ml-auto rounded-md px-4 py-2 font-serif text-[13px] text-octo-brass transition"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            {step === 1 ? (local ? "Add a provider" : "Continue") : "Add a provider"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] text-octo-mute transition hover:text-octo-sage"
          >
            Cancel
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
