import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import GridLayout from "react-grid-layout/legacy";
import type { Layout, LayoutItem } from "react-grid-layout/legacy";
import { Add, BoardSwitcher, Duplicate, Edit, Export, Generate, Info, LanguageSwitcher, LayoutIO, Refresh, Reset, User } from "@components";
import { Card } from "@ui";
import { formatTimestamp } from "@utils/time";
import "react-grid-layout/css/styles.css";
import styles from "./home.module.css";
import { CARDS, type Lang } from "./data";

// One grid unit = one background dot (20px); the visual gap between cards
// comes from padding inside each grid item (see home.module.css)
const CELL = 20;
const COLS = 250;
const GRID_WIDTH = CELL * COLS;
const STORAGE_KEY = "liveboard:layout";
const MOBILE_BREAKPOINT = 540;

function useIsMobile(breakpoint: number): boolean {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(`(max-width: ${breakpoint}px)`).matches);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = () => setIsMobile(mq.matches);
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);

  return isMobile;
}

type StoredItem = LayoutItem & { config?: Record<string, unknown> };

// A board is one layout: the grid items plus their per-card config, and an
// optional per-language display name (defaults to "Board N" when absent)
type Board = { name?: Record<string, string>; items: StoredItem[] };
type Store = { boards: Board[]; active: number };
// What the board-settings modal edits; older exports/drafts may still be a bare item array
type BoardConfig = { name?: Record<string, string>; items?: StoredItem[] } | StoredItem[];

const LANGS: Lang[] = ["en", "zh", "ja"];

const LAYOUT_FIELDS = new Set(["x", "y", "w", "h", "minW", "minH", "maxW", "maxH"]);

const CARDS_BY_ID = new Map(CARDS.map((c) => [c.i, c]));

function moduleId(instanceId: string): string {
  const sep = instanceId.indexOf(":");
  return sep === -1 ? instanceId : instanceId.slice(0, sep);
}

function toLayoutItem(card: (typeof CARDS)[number]): LayoutItem {
  const { i, x, y, w, h, minW, minH, maxW, maxH, static: isStatic } = card;
  return { i, x, y, w, h, minW, minH, maxW, maxH, static: isStatic };
}

function toGridLayout(items: StoredItem[]): Layout {
  return items.map((it) => {
    const item = { ...it };
    delete item.config;
    return item;
  });
}

// Modules grow comp fields over time — Note's `prompt` is one. A card stored before
// the field existed gets it filled in from the module's defaults, so it shows up in
// the card's Edit modal to be tuned rather than only existing as a hidden fallback.
function withCompDefaults(item: StoredItem): StoredItem {
  const defaults = CARDS_BY_ID.get(moduleId(item.i))?.comp;
  if (!defaults) return item;
  const comp = (item.config?.comp ?? {}) as Record<string, unknown>;
  const missing = Object.entries(defaults).filter(([key]) => !(key in comp));
  if (!missing.length) return item;
  return { ...item, config: { ...item.config, comp: { ...comp, ...Object.fromEntries(missing) } } };
}

// Drops anything that isn't a grid item of a module this build still ships
function sanitize(items: unknown): StoredItem[] {
  if (!Array.isArray(items)) return [];
  return (items as StoredItem[])
    .filter((it) => it && typeof it.i === "string" && CARDS_BY_ID.has(moduleId(it.i)))
    .map(withCompDefaults);
}

// Keeps only non-empty strings for known languages; undefined means "use the default label"
function sanitizeName(name: unknown): Record<string, string> | undefined {
  if (!name || typeof name !== "object" || Array.isArray(name)) return undefined;
  const out: Record<string, string> = {};
  for (const lng of LANGS) {
    const v = (name as Record<string, unknown>)[lng];
    if (typeof v === "string" && v.trim()) out[lng] = v.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

// Accepts both stored shapes: a bare item array (pre-name era) or { name, items }
function toBoard(entry: unknown): Board {
  if (Array.isArray(entry)) return { items: sanitize(entry) };
  if (entry && typeof entry === "object") {
    const b = entry as { name?: unknown; items?: unknown };
    const name = sanitizeName(b.name);
    return { ...(name ? { name } : {}), items: sanitize(b.items) };
  }
  return { items: [] };
}

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { boards?: unknown[]; active?: number };
      const boards = Array.isArray(parsed?.boards) ? parsed.boards.map(toBoard) : [];
      if (boards.length) {
        return { boards, active: Math.min(Math.max(parsed.active ?? 0, 0), boards.length - 1) };
      }
    }
  } catch {
    // fall through to a single empty board
  }
  return { boards: [{ items: [] }], active: 0 };
}

function nextY(layout: Layout): number {
  return layout.reduce((max, it) => Math.max(max, it.y + it.h), 0);
}

// The stretch of board the user can actually see, in grid units. The board is far
// wider and taller than the window, so this is what "on screen" means when a new
// card is looking for somewhere to go.
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

function visibleBounds(grid: HTMLDivElement | null): Bounds | null {
  if (!grid) return null;
  const rect = grid.getBoundingClientRect();
  // clientWidth/Height rather than innerWidth/Height: scrollbars are not board
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  // Whole cells only, so a spot that clears these bounds is fully on screen
  const bounds = {
    minX: Math.ceil(Math.max(0, -rect.left) / CELL),
    minY: Math.ceil(Math.max(0, -rect.top) / CELL),
    maxX: Math.floor(Math.min(GRID_WIDTH, vw - rect.left) / CELL),
    maxY: Math.floor((vh - rect.top) / CELL),
  };
  return bounds.maxX > bounds.minX && bounds.maxY > bounds.minY ? bounds : null;
}

function collides(items: StoredItem[], x: number, y: number, w: number, h: number): boolean {
  return items.some((it) => x < it.x + it.w && x + w > it.x && y < it.y + it.h && y + h > it.y);
}

// Where a card put down at (x, y) actually comes to rest: the grid compacts
// vertically, so a card rises until something is in its way
function settle(items: StoredItem[], x: number, y: number, w: number, h: number): number {
  let top = y;
  while (top > 0 && !collides(items, x, top - 1, w, h)) top--;
  return top;
}

// The first free w×h spot on the visible board, read top to bottom then left to
// right. Null when nothing that size is free on screen — a card wider or taller
// than the window never fits, and a full screen has nowhere to put one.
function findSpot(items: StoredItem[], w: number, h: number, bounds: Bounds): { x: number; y: number } | null {
  for (let y = bounds.minY; y + h <= bounds.maxY; y++) {
    for (let x = bounds.minX; x + w <= bounds.maxX; x++) {
      if (collides(items, x, y, w, h)) continue;
      const top = settle(items, x, y, w, h);
      // Rising off the top of the window is no better than landing below it
      if (top >= bounds.minY) return { x, y: top };
    }
  }
  return null;
}

// Somewhere on screen for a new card, or — only when the visible board has no
// room for one that size — below everything, where cards used to always land
function place(items: StoredItem[], w: number, h: number, bounds: Bounds | null): { x: number; y: number } {
  return (bounds && findSpot(items, w, h, bounds)) ?? { x: 0, y: nextY(items) };
}

// Command — or Ctrl, for a keyboard without one — held through a drag. The board
// normally floats every card up to the top of its column; a drag with this held
// down leaves the card where it is dropped instead.
function isFreeDrag(event: Event | null): boolean {
  const e = event as MouseEvent | null;
  return Boolean(e && (e.metaKey || e.ctrlKey));
}

// A card put down by a free drag stays put. `static` is what keeps the grid's
// vertical compaction off it — the other two flags put back the dragging and
// resizing that `static` alone would take away, since to the grid "static" means
// a card the user can't touch. Dragging it again without Command clears all three
// and it floats like any other card.
function setPinned<T extends LayoutItem>(item: T, pinned: boolean): T {
  return pinned
    ? { ...item, static: true, isDraggable: true, isResizable: true }
    : { ...item, static: false, isDraggable: undefined, isResizable: undefined };
}

type InfoItem = { key: Record<string, string>; value: Record<string, string> };
type InfoSection = { title: Record<string, string>; items: InfoItem[] };

// comp config is free-form per module, so anything read out of it has to be checked
function compText(comp: Record<string, unknown> | undefined, key: string): string {
  const value = comp?.[key];
  return typeof value === "string" ? value : "";
}

// What a card hands the board when its text isn't the one `comp.content` field the
// header's Generate button rewrites by default — Code's is the source of whichever
// language it happens to be showing, which only the card itself can say. `content`
// is a function so the run reads the text as it is when it starts, not as it was
// when the card registered.
type GenerateTarget = {
  content: () => string;
  prompt: string;
  onGenerated: (next: string) => void;
  // Called once when a run has stopped, with the text it left behind. `onGenerated`
  // fires many times a second and never says which chunk was the last, so a card
  // that acts on a finished rewrite rather than on the text itself — X renders its
  // document — has no other way to know the writing is over. The final text is
  // handed over rather than read back because the last `onGenerated` has not been
  // through a render yet, so the card's own copy is still one chunk behind.
  onDone?: (text: string) => void;
  // True for the whole run and false when it stops — including the wait before the
  // first words, which `onGenerated` cannot report because nothing has been written
  // yet. A card that shows something of its own while it is being rewritten needs
  // that opening stretch too: it is the one the board's own overlay is covering,
  // and the card is what shows through it.
  onBusy?: (busy: boolean) => void;
};

// One finished Generate run: the card's text before it, and the text it left
// behind. Runs on a card stack up, so Ctrl+Z walks back through them in order
// and Ctrl+Shift+Z walks forward again. `index` is how many are applied.
type GenEdit = { before: string; after: string };
type GenHistory = { edits: GenEdit[]; index: number };

// How far back a single card can be walked; each entry holds two whole copies
// of its text, so this is a memory bound rather than a useful limit
const GEN_HISTORY_LIMIT = 20;

// Something with an undo stack of its own — a modal's instruction box, the board
// name field. Ctrl+Z belongs to whatever is being typed in, not to a generation
function isTextField(el: Element | null): boolean {
  return (
    el instanceof HTMLElement &&
    (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")
  );
}

export default function Home() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language as Lang;
  const [store, setStore] = useState<Store>(loadStore);
  const isMobile = useIsMobile(MOBILE_BREAKPOINT);
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
  // A card that can re-read its data registers how (see `_setRefresh` below), and gets a
  // Refresh button in its header. Keyed by instance id, like the reset handlers below.
  const [refreshHandlers, setRefreshHandlers] = useState<Record<string, () => void | Promise<void>>>({});
  // A card that can put itself back to a clean state registers how (see `_setReset` below),
  // and gets a Reset button in its header. Keyed by instance id, so one Chat card resetting
  // leaves the others alone.
  const [resetHandlers, setResetHandlers] = useState<Record<string, () => void | Promise<void>>>({});
  // What a card is saying over its own content while it generates — the wait before
  // the first words arrive, or why nothing did. Keyed by instance id
  const [genStatus, setGenStatus] = useState<Record<string, { text: string; warning?: boolean }>>({});
  // Which cards are mid-generation, from the click through to the last word
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  // Cards that named their own Generate target (see `_setGenerate` below) rather than
  // taking the default one. Keyed by instance id
  const [generateTargets, setGenerateTargets] = useState<Record<string, GenerateTarget>>({});
  // What each card's finished runs changed, keyed by instance id. A ref rather than
  // state: nothing on screen is drawn from it, and a run in flight is already
  // re-rendering the board many times a second
  const genHistoryRef = useRef<Record<string, GenHistory>>({});
  // Which card Ctrl+Z means when the focus isn't in one — the card generated last,
  // which is where the user's attention was when the modal closed
  const lastGeneratedRef = useRef<string | null>(null);
  // The grid's own element, read for where the window is over the board when a
  // card is added. Null on mobile, which stacks the cards instead of gridding them.
  const gridRef = useRef<HTMLDivElement>(null);
  // Whether the drag in progress is a free one — Command is down. It turns the
  // grid's compaction off for as long as it lasts, so the card being dragged
  // follows the cursor rather than floating to the top of its column.
  const [freeDrag, setFreeDrag] = useState(false);
  // Only a drag cares about Command; without this, every Cmd+key the user pressed
  // would re-render the whole board twice for nothing
  const draggingRef = useRef(false);
  // What the drag that just ended decided about its card: pinned where it was
  // dropped, or back to floating. Read by `persist`, which is where the layout
  // the drag produced arrives — the grid reports that layout as it knew it, which
  // is before the pin.
  const pinRef = useRef<{ id: string; pinned: boolean } | null>(null);

  useEffect(() => {
    document.title = t("home.title");
  }, [t, i18n.language]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }, [store]);

  const items = useMemo(() => store.boards[store.active]?.items ?? [], [store]);

  // The active board split into what the grid needs and what the cards need
  const layout = useMemo<Layout>(() => toGridLayout(items), [items]);
  const configs = useMemo<Record<string, Record<string, unknown>>>(
    () =>
      Object.fromEntries(
        items
          .filter((it): it is StoredItem & { config: Record<string, unknown> } => Boolean(it.config))
          .map((it) => [it.i, it.config]),
      ),
    [items],
  );

  const updateItems = (next: (prev: StoredItem[]) => StoredItem[]) => {
    setStore((prev) => ({
      ...prev,
      boards: prev.boards.map((board, idx) => (idx === prev.active ? { ...board, items: next(board.items) } : board)),
    }));
  };

  const toStored = (nextLayout: Layout, nextConfigs: typeof configs): StoredItem[] =>
    nextLayout.map((item) => ({
      ...item,
      ...(nextConfigs[item.i] ? { config: nextConfigs[item.i] } : {}),
    }));

  const persist = (next: Layout) => {
    // What the drag that produced this layout decided about its card, if it was a
    // drag that got us here
    const pin = pinRef.current;
    pinRef.current = null;
    updateItems((prev) => {
      const before = new Map(prev.map((it) => [it.i, it]));
      return next.map((item) => {
        const was = before.get(item.i);
        // Where a card sits is the grid's to say, but whether it is pinned is the
        // board's: the grid hands back the layout as it knew it, which is from
        // before the drag that just pinned or unpinned something.
        const pinned = pin?.id === item.i ? pin.pinned : Boolean(was?.static);
        return { ...setPinned(item, pinned), ...(was?.config ? { config: was.config } : {}) };
      });
    });
  };

  // Command down when the drag starts, and again whenever it is pressed or let go
  // mid-drag: the card starts or stops floating there and then, so what the user
  // sees while dragging is where the card will land
  useEffect(() => {
    const syncFreeDrag = (e: KeyboardEvent) => {
      if (draggingRef.current) setFreeDrag(e.metaKey || e.ctrlKey);
    };
    window.addEventListener("keydown", syncFreeDrag);
    window.addEventListener("keyup", syncFreeDrag);
    return () => {
      window.removeEventListener("keydown", syncFreeDrag);
      window.removeEventListener("keyup", syncFreeDrag);
    };
  }, []);

  // The grid hands every drag callback the same six arguments; only the card being
  // dragged, where it started, and the mouse event behind it matter here
  type DragCallback = (
    layout: Layout,
    oldItem: LayoutItem | null,
    item: LayoutItem | null,
    placeholder: LayoutItem | null,
    e: Event,
  ) => void;

  const handleDragStart: DragCallback = (_layout, _oldItem, _item, _placeholder, e) => {
    draggingRef.current = true;
    pinRef.current = null;
    setFreeDrag(isFreeDrag(e));
  };

  const handleDragStop: DragCallback = (_layout, oldItem, item, _placeholder, e) => {
    draggingRef.current = false;
    setFreeDrag(false);
    // The card's header is its drag handle, and its buttons sit in that header, so
    // clicking Edit or Info is a drag of no distance as far as the grid is
    // concerned. A card that hasn't been carried anywhere says nothing about
    // whether it should be pinned, and pinning is only ever a drag's to decide.
    if (!item || !oldItem || (item.x === oldItem.x && item.y === oldItem.y)) return;
    pinRef.current = { id: item.i, pinned: isFreeDrag(e) };
  };

  // A card writing its own state back — Note's text as it is typed, or a Generate
  // rewrite — only ever touches the `comp` half of its config
  const saveComp = (id: string, comp: Record<string, unknown>) => {
    updateItems((prev) => prev.map((it) => (it.i === id ? { ...it, config: { ...(it.config ?? {}), comp } } : it)));
  };

  // Generated text lands here many times a second while it streams, so the comp it
  // builds on is read from the item being updated rather than from the render that
  // started the stream — which would be stale by the second chunk
  const saveContent = (id: string, content: string) => {
    updateItems((prev) =>
      prev.map((it) => {
        if (it.i !== id) return it;
        const comp = (it.config?.comp ?? {}) as Record<string, unknown>;
        return {
          ...it,
          config: {
            ...it.config,
            comp: { ...comp, content, createdAt: comp.createdAt ?? Date.now(), updatedAt: Date.now() },
          },
        };
      }),
    );
  };

  const handleSaveConfig = (id: string, saved: Record<string, unknown>) => {
    const layoutPatch: Record<string, unknown> = {};
    const moduleConfig: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(saved)) {
      if (LAYOUT_FIELDS.has(k)) layoutPatch[k] = v;
      else moduleConfig[k] = v;
    }

    updateItems((prev) => prev.map((it) => (it.i === id ? { ...it, ...layoutPatch, config: moduleConfig } : it)));
  };

  // Where a card's Generate reads its text and writes the rewrite back. A module
  // opts into AI rewriting either by declaring a `prompt` in its comp config — the
  // standing description of what its `content` field is — or, when its text isn't
  // that one field, by registering a target of its own (see `_setGenerate` below).
  // Null for a card that takes no rewrites, which is what leaves the button off it.
  const generateTarget = (id: string): GenerateTarget | null => {
    const registered = generateTargets[id];
    if (registered) return registered;
    const card = CARDS_BY_ID.get(moduleId(id));
    if (!card?.comp || !("prompt" in card.comp)) return null;
    // An id left over from another board — its history is still here, its card isn't
    if (!items.some((it) => it.i === id)) return null;
    return {
      // Read when called rather than now: a run streams for as long as it takes,
      // and an undo can come long after that
      content: () => compText(configs[id]?.comp as Record<string, unknown> | undefined, "content"),
      prompt:
        compText(configs[id]?.comp as Record<string, unknown> | undefined, "prompt") ||
        compText(card.comp, "prompt"),
      onGenerated: (next: string) => saveContent(id, next),
    };
  };

  // The keyboard handler below is set up once and outlives the render that made it,
  // so it resolves targets through this rather than through that render's configs
  const liveTargetRef = useRef(generateTarget);
  useEffect(() => {
    liveTargetRef.current = generateTarget;
  });

  // A finished run, recorded as one change however many times its text landed on
  // the card while it streamed. Anything undone and not put back is dropped: the
  // new text is what follows the old one now.
  const recordGeneration = (id: string, before: string, after: string) => {
    const history = genHistoryRef.current[id];
    const edits = [...(history ? history.edits.slice(0, history.index) : []), { before, after }].slice(
      -GEN_HISTORY_LIMIT,
    );
    genHistoryRef.current[id] = { edits, index: edits.length };
    lastGeneratedRef.current = id;
  };

  // A card that has gone — deleted, imported over, restored from the server — leaves
  // its rewrites behind. Dropping them here rather than at each of those places keeps
  // it to one rule: history for cards that are still on a board.
  useEffect(() => {
    const live = new Set(store.boards.flatMap((board) => board.items.map((it) => it.i)));
    for (const id of Object.keys(genHistoryRef.current)) {
      if (!live.has(id)) delete genHistoryRef.current[id];
    }
    if (lastGeneratedRef.current && !live.has(lastGeneratedRef.current)) lastGeneratedRef.current = null;
  }, [store]);

  // Ctrl+Z (Cmd+Z) puts back what a generated rewrite replaced, Ctrl+Shift+Z brings
  // the rewrite back again — on the card the focus is in, or failing that on the
  // last card generated.
  useEffect(() => {
    // One step back through a card's rewrites, or forward with `redo`. False when
    // there is nothing to step to, or when the card's text is no longer the text
    // that step produced: it has been edited since, and Ctrl+Z belongs to whatever
    // did that rather than to a run that finished before it.
    const step = (id: string, redo: boolean): boolean => {
      const history = genHistoryRef.current[id];
      const edit = history?.edits[redo ? history.index : history.index - 1];
      if (!history || !edit) return false;
      const target = liveTargetRef.current(id);
      if (!target) return false;
      const [from, to] = redo ? [edit.before, edit.after] : [edit.after, edit.before];
      if (target.content() !== from) return false;
      target.onGenerated(to);
      history.index += redo ? 1 : -1;
      lastGeneratedRef.current = id;
      return true;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || !(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== "z" && e.code !== "KeyZ") return;
      const active = document.activeElement;
      const inCard = active?.closest("[data-card-id]")?.getAttribute("data-card-id");
      // Typing somewhere of the board's own keeps its native undo; only a card, or
      // nothing in particular, reaches a generation
      if (!inCard && isTextField(active)) return;
      const id = inCard ?? lastGeneratedRef.current;
      // Nothing to step to leaves the key alone, so a card's own undo still works
      if (id && step(id, e.shiftKey)) e.preventDefault();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Custom name in the current language, else any language it was set in, else "Board N"
  const boardNames = store.boards.map(
    (board, i) =>
      board.name?.[lang] ?? LANGS.map((l) => board.name?.[l]).find(Boolean) ?? t("board.label", { n: i + 1 }),
  );

  // The settings modal pre-fills the default label in every language so the shape is visible
  const defaultBoardName = (n: number): Record<string, string> =>
    Object.fromEntries(LANGS.map((l) => [l, i18n.getFixedT(l)("board.label", { n })]));

  const activeModuleIds = new Set(layout.map((it) => moduleId(it.i)));
  const addItems = CARDS.map((c) => ({
    id: c.i,
    label: c.title[lang],
    disabled: c.allowMultipleInstances === false && activeModuleIds.has(c.i),
  }));

  const handleAdd = (id: string) => {
    const card = CARDS_BY_ID.get(id);
    if (!card) return;
    const instanceId = `${id}:${Date.now()}`;
    const defaultConfig: Record<string, unknown> = {
      title: { ...card.title },
      refreshAgeMinutes: card.refreshAgeMinutes,
      info: card.info.map((section) => ({
        title: { ...section.title },
        items: section.items.map((item) => ({ key: { ...item.key }, value: { ...item.value } })),
      })),
      ...(card.comp ? { comp: { ...card.comp } } : {}),
    };
    // Read before the update runs: where the window sits over the board is a
    // question for the DOM, and the updater is only allowed to look at the items
    const bounds = visibleBounds(gridRef.current);
    updateItems((prev) => [
      ...prev,
      { ...toLayoutItem(card), i: instanceId, ...place(prev, card.w, card.h, bounds), config: defaultConfig },
    ]);
  };

  const handleDuplicate = (id: string) => {
    const bounds = visibleBounds(gridRef.current);
    updateItems((prev) => {
      const source = prev.find((it) => it.i === id);
      if (!source) return prev;
      const instanceId = `${moduleId(id)}:${Date.now()}`;
      return [
        ...prev,
        {
          ...source,
          i: instanceId,
          ...place(prev, source.w, source.h, bounds),
          ...(source.config ? { config: structuredClone(source.config) } : {}),
        },
      ];
    });
  };

  const handleDelete = (id: string) => {
    updateItems((prev) => prev.filter((it) => it.i !== id));
  };

  const handleImport = (nextLayout: Layout, nextConfigs: typeof configs) => {
    updateItems(() => sanitize(toStored(nextLayout, nextConfigs)));
  };

  const handleSelectBoard = (index: number) => {
    setStore((prev) => ({ ...prev, active: index }));
  };

  const handleAddBoard = () => {
    setStore((prev) => ({ boards: [...prev.boards, { items: [] }], active: prev.boards.length }));
  };

  const handleSaveBoard = (next: BoardConfig) => {
    setStore((prev) => ({
      ...prev,
      boards: prev.boards.map((board, idx) => {
        if (idx !== prev.active) return board;
        if (Array.isArray(next)) return { ...board, items: sanitize(next) };
        const name = sanitizeName(next.name);
        return { ...(name ? { name } : {}), items: sanitize(next.items) };
      }),
    }));
  };

  // A layout downloaded from the user's server folder replaces the whole
  // store (all boards), running through the same sanitizing as loadStore
  const handleRestore = (data: unknown): boolean => {
    if (!data || typeof data !== "object") return false;
    const parsed = data as { boards?: unknown[]; active?: number };
    if (!Array.isArray(parsed.boards) || !parsed.boards.length) return false;
    const boards = parsed.boards.map(toBoard);
    setStore({ boards, active: Math.min(Math.max(parsed.active ?? 0, 0), boards.length - 1) });
    return true;
  };

  // Removing the last board leaves an empty one behind — there is always a board
  const handleDeleteBoard = () => {
    setStore((prev) => {
      const boards = prev.boards.filter((_, idx) => idx !== prev.active);
      if (!boards.length) return { boards: [{ items: [] }], active: 0 };
      return { boards, active: Math.min(prev.active, boards.length - 1) };
    });
  };

  const renderCard = (item: LayoutItem) => {
    const card = CARDS_BY_ID.get(moduleId(item.i));
    if (!card) return null;
    const cfg = configs[item.i] ?? {};
    const cfgTitle = cfg.title as Record<string, string> | undefined;
    const cfgInfo = Array.isArray(cfg.info) ? (cfg.info as InfoSection[]) : undefined;
    const cfgRefreshAge = cfg.refreshAgeMinutes as number | undefined;
    const cfgComp = cfg.comp as Record<string, unknown> | undefined;

    const displayTitle = cfgTitle?.[lang] ?? card.title[lang];
    const displaySections = cfgInfo ?? card.info;
    const displayCreatedAt = formatTimestamp(cfgComp?.createdAt, lang);
    // One "updated" line: when this card instance was last edited, or failing that
    // when the module itself was last updated (its last_updated.txt)
    const displayUpdatedAt = formatTimestamp(cfgComp?.updatedAt, lang) ?? card.fileLastUpdated;

    const editConfig: Record<string, unknown> = {
      title: cfgTitle ?? { ...card.title },
      refreshAgeMinutes: cfgRefreshAge ?? card.refreshAgeMinutes,
      info: cfgInfo ?? card.info,
      ...Object.fromEntries(
        Object.entries(cfg).filter(([k]) => k !== "title" && k !== "info" && k !== "refreshAgeMinutes"),
      ),
    };

    const generate = generateTarget(item.i);

    const isRefreshing = refreshingIds.has(item.i);
    const setRefreshing = (loading: boolean) => {
      setRefreshingIds((prev) => {
        const next = new Set(prev);
        if (loading) next.add(item.i);
        else next.delete(item.i);
        return next;
      });
    };

    return (
      <Card
        title={displayTitle}
        actions={
          <>
            {refreshHandlers[item.i] && (
              <Refresh onRefresh={refreshHandlers[item.i]} onLoadingChange={setRefreshing} />
            )}
            {resetHandlers[item.i] && <Reset onReset={resetHandlers[item.i]} />}
            <Info
              title={displayTitle}
              sections={displaySections}
              createdAt={displayCreatedAt}
              updatedAt={displayUpdatedAt}
            />
            {generate && (
              <Generate
                content={generate.content}
                prompt={generate.prompt}
                onGenerated={generate.onGenerated}
                onCommit={(before, after) => {
                  recordGeneration(item.i, before, after);
                  generate.onDone?.(after);
                }}
                onStatus={(text, warning) =>
                  setGenStatus((prev) => {
                    if (!text) {
                      if (!(item.i in prev)) return prev;
                      const next = { ...prev };
                      delete next[item.i];
                      return next;
                    }
                    return { ...prev, [item.i]: { text, warning } };
                  })
                }
                onBusy={(busy) => {
                  generate.onBusy?.(busy);
                  setGeneratingIds((prev) => {
                    if (prev.has(item.i) === busy) return prev;
                    const next = new Set(prev);
                    if (busy) next.add(item.i);
                    else next.delete(item.i);
                    return next;
                  });
                }}
              />
            )}
            <Export title={displayTitle} />
            {card.allowMultipleInstances !== false && <Duplicate id={item.i} onDuplicate={handleDuplicate} />}
            <Edit config={editConfig} onSave={(c) => handleSaveConfig(item.i, c)} onDelete={() => handleDelete(item.i)} />
          </>
        }
      >
        <div
          className={styles.contentWrapper}
          data-module={moduleId(item.i)}
          data-generating={generatingIds.has(item.i) ? "" : undefined}
        >
          {isRefreshing && <div className={styles.statusOverlay}>{t("refresh.loading")}</div>}
          {genStatus[item.i] && (
            <div
              className={`${styles.statusOverlay}${genStatus[item.i].warning ? ` ${styles.statusOverlayWarning}` : ""}`}
            >
              {genStatus[item.i].text}
            </div>
          )}
          {card.content({
            ...cfg,
            // This card instance's id, for components that need to tell themselves apart
            // from a copy of the same card (e.g. Chat owns one CLI process per card)
            _id: item.i,
            // Cards that can re-read their data say how here, which is also what puts a Refresh
            // button in their header. Pass null to take it away again. Re-reading only: this
            // must not run a fetch script, so a click costs the card's own requests and nothing
            // more.
            _setRefresh: (fn: (() => void | Promise<void>) | null) => {
              setRefreshHandlers((prev) => {
                if (fn) return prev[item.i] === fn ? prev : { ...prev, [item.i]: fn };
                if (!(item.i in prev)) return prev;
                const next = { ...prev };
                delete next[item.i];
                return next;
              });
            },
            // Cards that can start over say how here, which is also what puts a Reset button
            // in their header. Pass null to take it away again.
            _setReset: (fn: (() => void | Promise<void>) | null) => {
              setResetHandlers((prev) => {
                if (fn) return prev[item.i] === fn ? prev : { ...prev, [item.i]: fn };
                if (!(item.i in prev)) return prev;
                const next = { ...prev };
                delete next[item.i];
                return next;
              });
            },
            // Cards whose text isn't the `comp.content` field say what Generate should
            // rewrite here (e.g. Code, whose text is the source of the language it is
            // showing), which is also what puts a Generate button in their header.
            // Pass null to take it away again.
            _setGenerate: (target: GenerateTarget | null) => {
              setGenerateTargets((prev) => {
                if (target) return prev[item.i] === target ? prev : { ...prev, [item.i]: target };
                if (!(item.i in prev)) return prev;
                const next = { ...prev };
                delete next[item.i];
                return next;
              });
            },
            // Allows components to persist their comp config directly (e.g. Note auto-saves content on change)
            _save: (comp: Record<string, unknown>) => saveComp(item.i, comp),
            // Lets a card remove itself (e.g. Calculator's Mac-style close box), same as the Edit modal's delete
            _delete: () => handleDelete(item.i),
          })}
        </div>
      </Card>
    );
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>{t("home.title")}</h1>
        <div className={styles.actions}>
          <Add items={addItems} onAdd={handleAdd} />
          <BoardSwitcher
            names={boardNames}
            active={store.active}
            onSelect={handleSelectBoard}
            onAdd={handleAddBoard}
          />
          <Edit<BoardConfig>
            config={{
              name: store.boards[store.active]?.name ?? defaultBoardName(store.active + 1),
              items,
            }}
            title={t("board.edit")}
            hideTooltip
            onSave={handleSaveBoard}
            onDelete={handleDeleteBoard}
          />
          <LayoutIO layout={layout} configs={configs} onImport={handleImport} />
          <User store={store} onRestore={handleRestore} />
          <LanguageSwitcher />
        </div>
      </header>

      {isMobile ? (
        <div className={styles.mobileList}>
          {[...layout]
            .sort((a, b) => a.y - b.y || a.x - b.x)
            .map((item) => {
              const content = renderCard(item);
              if (!content) return null;
              return (
                <div
                  key={item.i}
                  className={styles.mobileItem}
                  data-card-id={item.i}
                  style={{ height: item.h * CELL }}
                >
                  {content}
                </div>
              );
            })}
        </div>
      ) : (
        <GridLayout
          key={store.active}
          innerRef={gridRef}
          className={styles.content}
          layout={layout}
          onLayoutChange={persist}
          onDragStart={handleDragStart}
          onDragStop={handleDragStop}
          cols={COLS}
          rowHeight={CELL}
          margin={[0, 0]}
          containerPadding={[0, 0]}
          // Cards float up to fill the space above them, unless the drag is a free
          // one (Command held) — then they stay where they are put
          compactType={freeDrag ? null : "vertical"}
          // A free drag disturbs nothing: a card that would land on top of another
          // one is held back at the last free spot instead of pushing it aside.
          // Pushing is also how the grid displaces a pinned card, which is the one
          // thing a pin is supposed to prevent.
          preventCollision={freeDrag}
          draggableHandle=".card-drag-handle"
          // The header is the drag handle and the card's buttons sit in it, so a touch
          // on Edit or Info is a drag start as far as the grid is concerned — and the
          // drag calls preventDefault() on `touchstart`, which is what stops the browser
          // from ever synthesising the tap's click. On a mouse that costs nothing (a drag
          // of no distance, see handleDragStop), but on a touchscreen it swallows the
          // button entirely: the card moves, the button never fires. Naming the button
          // strip here makes the grid let the touch through untouched.
          draggableCancel="[data-card-actions]"
          width={GRID_WIDTH}
        >
          {layout.map((item) => (
            <div key={item.i} data-card-id={item.i}>
              {renderCard(item)}
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
