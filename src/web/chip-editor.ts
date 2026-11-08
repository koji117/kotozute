// カテゴリの札を、辞書の言葉から選んで並べ替える（AI を通さない）。並びはこのブラウザだけに保存する
import { CHIPS, DICT, DICT_KEYS, type DictKey } from '../ops/dict';
import { CHIP_ICON, svg16 } from './panel';

const KEY = 'kotozute.chips';
const UP = svg16('M8 13V3M4 7l4-4 4 4'), DOWN = svg16('M8 3v10M4 9l4 4 4-4');

/** 保存した並び。辞書にない言葉と重なりは捨て、何も残らなければ既定（CHIPS）。保存が使えなくても動く */
export function loadChips(): DictKey[] {
  let v: unknown = null;
  try { v = JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch {}
  const ws = Array.isArray(v) ? [...new Set(v.filter((k): k is DictKey => typeof k === 'string' && Object.hasOwn(DICT, k)))] : [];
  return ws.length ? ws : [...CHIPS];
}

/**
 * 編集の窓（index.html の #chip-editor）。popover なので、Esc と外のクリックで閉じ、Esc では編集のボタンにフォーカスが戻る。
 * set は画面の札の並びを替える（外した札の結果を隠すのは main.ts）
 */
export function chipEditor(pop: HTMLElement, row: HTMLElement, o: { get: () => DictKey[]; set: (ws: DictKey[]) => void }) {
  const list = pop.querySelector('ul')!;
  const focus = (s: string) => pop.querySelector<HTMLElement>(`${s}:not(:disabled)`);
  function render() {
    const ws = o.get();
    // 出している言葉（並びの順）、そのあとに出していない言葉（辞書の順）。文は辞書の定数だけ
    list.innerHTML = [...ws, ...DICT_KEYS.filter((k) => !ws.includes(k))].map((w) => {
      const i = ws.indexOf(w), l = DICT[w].label;
      const move = i < 0 ? '' : `<button type="button" data-w="${w}" data-act="up" aria-label="${l}を上へ"${i === 0 ? ' disabled' : ''}>${UP}</button>`
        + `<button type="button" data-w="${w}" data-act="down" aria-label="${l}を下へ"${i === ws.length - 1 ? ' disabled' : ''}>${DOWN}</button>`;
      // 最後の1つは外せない
      return `<li class="${i < 0 ? 'off' : 'on'}"><label><input type="checkbox" data-w="${w}"${i < 0 ? '' : ' checked'}${i >= 0 && ws.length === 1 ? ' disabled' : ''}>${CHIP_ICON[w] ?? ''}<span>${l}</span></label>${move}</li>`;
    }).join('');
    place();
  }
  /** パソコンでは札の並びのすぐ下に出す（スマホは CSS で下部シート）。札が増えて折り返したら下げる */
  function place() {
    if (matchMedia('(max-width: 767px)').matches) { pop.style.cssText = ''; return; }
    const r = row.getBoundingClientRect(), top = r.bottom + 8;
    Object.assign(pop.style, { top: `${top}px`, left: `${Math.max(16, Math.min(r.left, innerWidth - 316))}px`, maxHeight: `${innerHeight - top - 16}px` });
  }
  /** 並びを替えて保存し、押したものにフォーカスを残す（押せなくなったら同じ言葉の別の操作へ） */
  function change(ws: DictKey[], w: DictKey, act?: string) {
    if (ws.length) {
      o.set(ws);
      try { localStorage.setItem(KEY, JSON.stringify(ws)); } catch {}
    }
    render();
    (act ? focus(`[data-w="${w}"][data-act="${act}"]`) ?? focus(`button[data-w="${w}"]`) : focus(`input[data-w="${w}"]`))?.focus();
  }
  list.addEventListener('change', (e) => {
    const c = e.target as HTMLInputElement, w = c.dataset.w as DictKey, ws = o.get();
    change(c.checked ? [...ws, w] : ws.filter((k) => k !== w), w);
  });
  list.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-act]');
    if (!b) return;
    const w = b.dataset.w as DictKey, ws = [...o.get()], i = ws.indexOf(w), j = b.dataset.act === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ws.length) return;
    [ws[i], ws[j]] = [ws[j], ws[i]];
    change(ws, w, b.dataset.act);
  });
  pop.querySelector('[data-act="reset"]')!.addEventListener('click', () => {
    o.set([...CHIPS]);
    try { localStorage.removeItem(KEY); } catch {}
    render();
  });
  // 閉じるときに先頭へ戻す（開く前は箱がなく、scrollTop が効かない）
  pop.addEventListener('beforetoggle', (e) => { if ((e as Event & { newState?: string }).newState === 'open') render(); else pop.scrollTop = 0; });
}
