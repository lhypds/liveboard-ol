import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionButton, Modal, showToast, TextArea } from "@ui";
import { generateEdit, getScAccount, NoScCredentialError } from "@utils/sc";
import styles from "./generate.module.css";

/**
 * How often the streaming text is pushed into the card. Every token would re-save
 * the whole board that many times; at this interval the text still arrives as a
 * steady stream to watch, and the final version is written unconditionally.
 */
const STREAM_INTERVAL_MS = 60;

/** How long a failure stays on the card before it clears itself */
const ERROR_HOLD_MS = 5000;

/**
 * What the card shows mid-stream: the answer so far laid over the text that is
 * already there, so the old words are overwritten in place instead of the card
 * being blanked first.
 *
 * The overlay is line by line, not character by character. Splicing on a raw
 * index would let a newline in the answer shift everything the answer hasn't
 * reached yet down a row, and the old text would crawl down the card as it went.
 * Overwriting within each line keeps every untouched line where it was: finished
 * lines replace theirs outright, the line being written keeps the tail of the one
 * underneath it, and the rest are left alone.
 */
function overlay(partial: string, original: string): string {
  const written = partial.split("\n");
  const lines = original.split("\n");
  for (let i = 0; i < written.length; i++) {
    const line = written[i];
    const under = lines[i] ?? "";
    lines[i] = i === written.length - 1 ? line + under.slice(line.length) : line;
  }
  return lines.join("\n");
}

type GenerateProps = {
  /**
   * The card's current text; what gets rewritten. Read when the run starts rather
   * than at render — a card's text can be whatever it is showing at the time (Code
   * hands over the source of whichever language is selected)
   */
  content: () => string;
  /**
   * The card's `prompt` config: a standing description of the scenario, so the
   * model knows what this content is before it reads the instruction
   */
  prompt?: string;
  /** Replaces the card's text — called repeatedly as the answer streams in */
  onGenerated: (next: string) => void;
  /**
   * The whole run as one change, once it has stopped: the text as it was, and the
   * text left on the card. What the board's Ctrl+Z steps back through
   */
  onCommit?: (before: string, after: string) => void;
  /** What to show over the card's content while it works; "" clears it */
  onStatus?: (status: string, isWarning?: boolean) => void;
  /** True for the whole run — the wait for the first words, and the writing after */
  onBusy?: (busy: boolean) => void;
};

export default function Generate({ content, prompt, onGenerated, onCommit, onStatus, onBusy }: GenerateProps) {
  const { t } = useTranslation();
  const label = t("generate.tooltip");
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A card unmounted (deleted, board switched) mid-generation shouldn't leave the
  // request running, nor a status stuck on the card it came back to
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    },
    [],
  );

  function warn(message: string) {
    onStatus?.(message, true);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => onStatus?.(""), ERROR_HOLD_MS);
  }

  /**
   * Nothing here works without a simple-ai login, so say so on the way in rather
   * than letting the instruction be typed and fail on send. A toast, not a status
   * over the card: the fix is in the user menu, not on the card.
   */
  function handleOpen() {
    if (!getScAccount().token) {
      showToast(t("generate.noCredential"));
      return;
    }
    setOpen(true);
  }

  async function handleGenerate() {
    const edit = instruction.trim();
    // An empty card is fine — that asks for a first draft rather than a rewrite
    if (loading || !edit) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    onBusy?.(true);
    // The note sits behind this modal, so get out of its way before the text
    // starts landing in it. From here on, progress is shown over the card
    setOpen(false);
    setInstruction("");
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    onStatus?.(t("generate.working"));

    // Read once, here: the rest of the run overlays its answer onto this text, so
    // it has to be the same text from the first chunk to the last
    const original = content();

    // The last text this run put on the card. Held in an object rather than a
    // plain variable because it is written from the stream callback below and
    // read back out here once the run is over
    const wrote = { text: original };
    const write = (text: string) => {
      wrote.text = text;
      onGenerated(text);
    };

    let streamed = false;
    let lastWrite = 0;
    try {
      const next = await generateEdit({
        content: original,
        instruct: prompt,
        prompt: edit,
        // Until the first words land there is nothing to watch, so the card
        // carries whatever simple-ai is doing; after that the text speaks for itself
        onStatus: (status) => {
          if (!streamed && !controller.signal.aborted) onStatus?.(status);
        },
        onText: (partial) => {
          if (controller.signal.aborted) return;
          if (!streamed) {
            streamed = true;
            onStatus?.("");
          }
          const now = Date.now();
          if (now - lastWrite < STREAM_INTERVAL_MS) return;
          lastWrite = now;
          // The final write below trims whatever of the original is left over
          write(overlay(partial, original));
        },
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!next.trim()) {
        warn(t("generate.emptyResult"));
        return;
      }
      onStatus?.("");
      // The throttle may have skipped the last chunks
      write(next);
    } catch (err) {
      if (controller.signal.aborted) return;
      // Only reachable if the account was cleared after the modal opened; same
      // message, same place as the check above
      if (err instanceof NoScCredentialError) showToast(t("generate.noCredential"));
      else warn(err instanceof Error && err.message ? err.message : t("generate.failed"));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setLoading(false);
      onBusy?.(false);
      // One entry for the whole run, from here rather than from the success path
      // alone: a run that fails after the first chunks leaves half a rewrite on
      // the card, which is exactly when putting the old text back matters most
      if (!controller.signal.aborted && wrote.text !== original) onCommit?.(original, wrote.text);
      // Aborting means the card was unmounted mid-run; don't let its status be
      // waiting there if the same card comes back (a board switched away and back)
      if (controller.signal.aborted) onStatus?.("");
    }
  }

  /* The handler below is subscribed for as long as the modal is open, so it outlives
     the renders under it — every keystroke in the box is one — and has to reach the
     current handleGenerate rather than the one from the render that subscribed it,
     whose `instruction` is whatever had been typed at that point. */
  const generateRef = useRef(handleGenerate);
  useEffect(() => {
    generateRef.current = handleGenerate;
  });

  /* Cmd/Ctrl+Enter sends, Escape closes. Listened for on the document rather than on
     the box, so both keys mean the same thing wherever the focus has ended up in the
     modal — the box, a button, nothing in particular. The board's own shortcut
     handler answers only to Ctrl/Cmd+Z, so there is nothing here to collide with. */
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        return;
      }
      // Plain Enter stays a newline. This box is where a multi-line instruction gets
      // written, and sending on Enter alone would cost one every time.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        void generateRef.current();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <>
      <ActionButton tooltip={label} onClick={handleOpen}>
        {/* Brain, after the one on the q project's generate button. Two lobes and a
            midline rather than q's five paths: card icons render at 10px with a
            stroke 2 units wide, at which q's outline closes into a solid blob */}
        <svg viewBox="0 0 24 24">
          <path d="M12 4.5A4.5 4.5 0 0 0 4 7.3 4 4 0 0 0 3.2 14 4.6 4.6 0 0 0 12 19.5" />
          <path d="M12 4.5A4.5 4.5 0 0 1 20 7.3 4 4 0 0 1 20.8 14 4.6 4.6 0 0 1 12 19.5" />
          <path d="M12 4.5v15" />
        </svg>
      </ActionButton>
      {/* The heading names what goes in the box — the prompt — rather than the
          card it came from, which is already on screen behind the modal */}
      <Modal isOpen={open} onClose={() => setOpen(false)} title={t("generate.title")}>
        <TextArea
          className={styles.instruction}
          value={instruction}
          disabled={loading}
          autoFocus
          minHeight={120}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInstruction(e.target.value)}
        />
        <div className={styles.buttons}>
          <button
            type="button"
            className={styles.generateButton}
            onClick={handleGenerate}
            disabled={loading || !instruction.trim()}
          >
            {loading ? t("generate.working") : t("generate.action")}
          </button>
          <button type="button" className={styles.cancelButton} onClick={() => setOpen(false)} disabled={loading}>
            {t("button.cancel")}
          </button>
        </div>
      </Modal>
    </>
  );
}
