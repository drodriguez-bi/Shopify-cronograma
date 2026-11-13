'use client';
import { Fragment, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type StoreOption = {
  id: number; key: string; name: string;
  state: 'connected' | 'expiring_soon' | 'expired' | 'not_connected';
};
type Variant = {
  id: number; variant_id: number; title: string | null; sku: string | null;
  price: string; compare_at_price: string | null; inventory_qty: number;
};
type Product = { id: number; product_id: number; title: string; handle: string | null; status: string; image_url: string | null; variants: Variant[] };
type Task = {
  id: number; store_key: string; type: string; label: string | null;
  run_at: string; revert_at: string | null; status: string; last_error: string | null; source: string;
  item_count?: number | null;
};

const statusLabels: Record<string, string> = { pending: 'Pendiente', active: 'Activa', completed: 'Completada', failed: 'Fallida', cancelled: 'Cancelada' };
const typeLabels: Record<string, string> = { publish: 'Publicación', inventory: 'Inventario', price: 'Precio promo', theme_publish: 'Publicar tema',
  price_batch: 'Precio promo (lote)', inventory_batch: 'Inventario (lote)', publish_batch: 'Publicar (lote)' };

function toIso(datetimeLocal: string): string {
  return new Date(datetimeLocal).toISOString();
}

/** Lee solo los encabezados del CSV y adivina qué se va a programar (igual que el servidor). */
function sniffCsvAction(text: string): 'price' | 'inventory' | 'publish' | null {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  if (!first.trim()) return null;
  const delim = [',', ';', '\t'].map(d => ({ d, n: first.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  const headers = first.split(delim).map(h => h.replace(/"/g, '').trim().toLowerCase());
  if (headers.includes('promo_price') || headers.includes('variant price')) return 'price';
  if (headers.includes('quantity') || headers.includes('variant inventory qty')) return 'inventory';
  return 'publish';
}

export default function SchedulerPage() {
  const router = useRouter();
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [storeKey, setStoreKey] = useState('');
  const [locations, setLocations] = useState<{ id: string; name: string; active: boolean }[]>([]);
  const [locationId, setLocationId] = useState('');
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [themes, setThemes] = useState<{ id: string; name: string; role: string }[]>([]);
  const [themeId, setThemeId] = useState('');
  const [themeRunAt, setThemeRunAt] = useState('');
  const [themesMsg, setThemesMsg] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<Set<number>>(new Set());
  const [selectedVariants, setSelectedVariants] = useState<Set<number>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);

  const [modal, setModal] = useState<null | 'publish' | 'inventory' | 'price' | 'csv' | 'detail'>(null);
  const [publishRunAt, setPublishRunAt] = useState('');
  const [invMode, setInvMode] = useState<'add' | 'set'>('add');
  const [invRunAt, setInvRunAt] = useState('');
  const [invQty, setInvQty] = useState<Record<number, string>>({});
  const [priceStart, setPriceStart] = useState('');
  const [priceEnd, setPriceEnd] = useState('');
  const [priceVals, setPriceVals] = useState<Record<number, { promo?: string; compare?: string }>>({});
  const [bulkQty, setBulkQty] = useState('');
  const [search, setSearch] = useState('');
  const [groupVals, setGroupVals] = useState<Record<number, { promo?: string; compare?: string }>>({});
  const [groupQty, setGroupQty] = useState<Record<number, string>>({});
  const [detail, setDetail] = useState<{ task: any; items: any[] } | null>(null);
  const [bulkPromo, setBulkPromo] = useState('');
  const [bulkCompare, setBulkCompare] = useState('');
  const [csvText, setCsvText] = useState('');
  const [csvResult, setCsvResult] = useState<{ dryRun: boolean; action?: string; hint?: string; batches?: number; created: number; skipped: number; errors: { row: number; error: string }[]; preview: string[] } | null>(null);
  const [csvAction, setCsvAction] = useState<'auto' | 'price' | 'inventory' | 'publish'>('auto');
  const [csvRunAt, setCsvRunAt] = useState('');
  const [csvRevertAt, setCsvRevertAt] = useState('');
  const [csvMode, setCsvMode] = useState<'add' | 'set'>('add');
  const [csvBusy, setCsvBusy] = useState(false);

  const variantById = new Map<number, Variant & { productTitle: string; productCacheId: number }>();
  products.forEach(p => p.variants.forEach(v => variantById.set(v.id, { ...v, productTitle: p.title, productCacheId: p.id })));

  // Búsqueda sobre la lista de productos (nombre o handle)
  const q = search.trim().toLowerCase();
  const visibleProducts = q ? products.filter(p => p.title.toLowerCase().includes(q) || (p.handle || '').toLowerCase().includes(q)) : products;
  const allVisibleSelected = visibleProducts.length > 0 && visibleProducts.every(p => selectedProducts.has(p.id));

  // Variantes seleccionadas agrupadas por producto (para editar un producto completo de una vez)
  const selectedGroups = (() => {
    const m = new Map<number, number[]>();
    for (const id of selectedVariants) {
      const v = variantById.get(id);
      if (v) m.set(v.productCacheId, [...(m.get(v.productCacheId) ?? []), id]);
    }
    return [...m.entries()].map(([pid, ids]) => ({ pid, ids, title: variantById.get(ids[0])!.productTitle }));
  })();
  const selectedIds = selectedGroups.flatMap(g => g.ids);

  const csvEffective: 'price' | 'inventory' | 'publish' | null = csvAction === 'auto' ? sniffCsvAction(csvText) : csvAction;

  useEffect(() => { loadStores(); loadTasks(); }, []);
  useEffect(() => {
    setLocationId('');
    setLocations([]);
    setProducts([]);
    setSelectedProducts(new Set());
    setSelectedVariants(new Set());
    setSearch('');
    setThemes([]);
    setThemeId('');
    setThemesMsg('');
    if (storeKey) { loadLocations(storeKey); loadThemes(storeKey); }
  }, [storeKey]);
  useEffect(() => { if (storeKey && locationId) loadProducts(storeKey); else setProducts([]); }, [storeKey, locationId]);

  async function loadStores() {
    const res = await fetch('/api/scheduler/stores').then(r => r.json());
    if (res.ok) setStores(res.stores);
  }
  async function loadThemes(key: string) {
    const res = await fetch(`/api/scheduler/themes?storeKey=${encodeURIComponent(key)}`).then(r => r.json());
    if (res.ok) setThemes(res.themes);
    else setThemesMsg('No se pudieron cargar los temas: ' + res.error);
  }
  async function submitTheme() {
    if (!themeId || !themeRunAt) return alert('Elige el tema y la fecha/hora.');
    const theme = themes.find(t => t.id === themeId);
    if (!confirm(`¿Programar la publicación de "${theme?.name}"? Al llegar la hora reemplazará al tema publicado.`)) return;
    const res = await fetch('/api/scheduler/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'schedule_theme_publish', storeKey, themeId, themeName: theme?.name, runAt: toIso(themeRunAt) }),
    }).then(r => r.json());
    if (res.ok) { alert('Publicación de tema programada.'); setThemeId(''); setThemeRunAt(''); loadTasks(); }
    else alert('Error: ' + res.error);
  }
  async function loadLocations(key: string) {
    setLoadingLocations(true);
    const res = await fetch(`/api/scheduler/locations?storeKey=${encodeURIComponent(key)}`).then(r => r.json());
    setLoadingLocations(false);
    if (res.ok) setLocations(res.locations);
    else alert('Error al cargar sucursales: ' + res.error);
  }
  async function loadProducts(key: string) {
    const res = await fetch(`/api/scheduler/products?storeKey=${encodeURIComponent(key)}`).then(r => r.json());
    if (res.ok) setProducts(res.products);
  }
  async function loadTasks() {
    const res = await fetch('/api/scheduler/tasks').then(r => r.json());
    if (res.ok) setTasks(res.tasks);
  }
  async function logout() {
    await fetch('/api/scheduler/auth/logout', { method: 'POST' });
    router.push('/login');
  }

  async function doSync() {
    setSyncing(true); setSyncMsg('Sincronizando...');
    const res = await fetch('/api/scheduler/products/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storeKey }),
    }).then(r => r.json());
    setSyncMsg(res.ok ? `Sincronizados ${res.synced} productos.` : 'Error: ' + res.error);
    setSyncing(false);
    if (res.ok) loadProducts(storeKey);
  }

  // Marcar un producto marca todas sus variantes (puedes desmarcar alguna después).
  function toggleProduct(p: Product) {
    const on = !selectedProducts.has(p.id);
    setSelectedProducts(prev => { const n = new Set(prev); on ? n.add(p.id) : n.delete(p.id); return n; });
    setSelectedVariants(prev => { const n = new Set(prev); p.variants.forEach(v => (on ? n.add(v.id) : n.delete(v.id))); return n; });
  }
  function toggleAllVisible() {
    const on = !allVisibleSelected;
    setSelectedProducts(prev => { const n = new Set(prev); visibleProducts.forEach(p => (on ? n.add(p.id) : n.delete(p.id))); return n; });
    setSelectedVariants(prev => { const n = new Set(prev); visibleProducts.forEach(p => p.variants.forEach(v => (on ? n.add(v.id) : n.delete(v.id)))); return n; });
  }
  function toggleVariant(id: number) {
    setSelectedVariants(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function submitPublish() {
    if (!publishRunAt) return alert('Selecciona fecha y hora.');
    const res = await fetch('/api/scheduler/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'schedule_publish', storeKey, runAt: toIso(publishRunAt), productCacheIds: [...selectedProducts] }),
    }).then(r => r.json());
    finishSchedule(res);
  }

  function openInventoryModal() { setInvQty({}); setGroupQty({}); setBulkQty(''); setModal('inventory'); }
  function openPriceModal() { setPriceVals({}); setGroupVals({}); setBulkPromo(''); setBulkCompare(''); setModal('price'); }

  // Un campo por producto: llena todas sus variantes (cada una se puede ajustar después).
  function setGroupQtyFor(pid: number, ids: number[], value: string) {
    setGroupQty(prev => ({ ...prev, [pid]: value }));
    setInvQty(prev => { const n = { ...prev }; for (const id of ids) { if (value === '') delete n[id]; else n[id] = value; } return n; });
  }
  function setGroupPrice(pid: number, ids: number[], field: 'promo' | 'compare', value: string) {
    setGroupVals(prev => ({ ...prev, [pid]: { ...prev[pid], [field]: value } }));
    setPriceVals(prev => { const n = { ...prev }; for (const id of ids) n[id] = { ...n[id], [field]: value === '' ? undefined : value }; return n; });
  }
  function applyBulkQty() { for (const g of selectedGroups) setGroupQtyFor(g.pid, g.ids, bulkQty); }
  function applyBulkPrice() {
    for (const g of selectedGroups) {
      if (bulkPromo) setGroupPrice(g.pid, g.ids, 'promo', bulkPromo);
      if (bulkCompare) setGroupPrice(g.pid, g.ids, 'compare', bulkCompare);
    }
  }

  async function openDetail(id: number) {
    const res = await fetch(`/api/scheduler/tasks/detail?id=${id}`).then(r => r.json());
    if (res.ok) { setDetail({ task: res.task, items: res.items }); setModal('detail'); }
    else alert('Error: ' + res.error);
  }

  const labelOf = (id: number) => `${variantById.get(id)?.productTitle} — ${variantById.get(id)?.title || 'Default Title'}`;
  const listNames = (names: string[]) => names.slice(0, 5).join(', ') + (names.length > 5 ? ` y ${names.length - 5} más` : '');

  async function submitInventory() {
    if (!invRunAt) return alert('Selecciona fecha y hora.');
    // Si no tocaste el campo, vale el 10 que se muestra por defecto.
    const items = selectedIds.map(id => ({
      variantCacheId: id, label: labelOf(id), quantity: parseInt(invQty[id] ?? '10', 10),
    }));
    const bad = items.filter(i => !i.quantity || i.quantity <= 0).map(i => i.label);
    if (bad.length) return alert('Falta una cantidad válida en: ' + listNames(bad));
    const res = await fetch('/api/scheduler/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'schedule_inventory', storeKey, runAt: toIso(invRunAt), mode: invMode, locationId, items }),
    }).then(r => r.json());
    finishSchedule(res);
  }

  async function submitPrice() {
    if (!priceStart || !priceEnd) return alert('Completa las fechas de inicio y fin.');
    if (new Date(priceEnd) <= new Date(priceStart)) return alert('La fecha de fin debe ser posterior a la de inicio.');
    // El tachado, si no lo tocaste, vale el precio actual que se muestra por defecto.
    const items = selectedIds.map(id => ({
      variantCacheId: id,
      label: labelOf(id),
      promoPrice: parseFloat(priceVals[id]?.promo ?? ''),
      compareAtPrice: parseFloat(priceVals[id]?.compare ?? String(variantById.get(id)?.price ?? '')),
    }));
    const noPromo = items.filter(i => !i.promoPrice || i.promoPrice <= 0).map(i => i.label);
    if (noPromo.length) return alert('Falta el precio promocional en: ' + listNames(noPromo));
    const noCompare = items.filter(i => !i.compareAtPrice || i.compareAtPrice <= 0).map(i => i.label);
    if (noCompare.length) return alert('Falta el precio tachado en: ' + listNames(noCompare));
    const odd = items.filter(i => i.promoPrice >= i.compareAtPrice).map(i => i.label);
    if (odd.length && !confirm(`${odd.length} variante(s) tienen el precio promo igual o mayor al tachado (${listNames(odd)}). ¿Continuar?`)) return;
    const res = await fetch('/api/scheduler/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'schedule_price', storeKey, runAt: toIso(priceStart), revertAt: toIso(priceEnd), items }),
    }).then(r => r.json());
    finishSchedule(res);
  }

  async function retryTask(id?: number) {
    const res = await fetch('/api/scheduler/tasks/retry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id ? { taskId: id } : {}),
    }).then(r => r.json());
    if (res.ok) { alert(`${res.retried} tarea(s) vuelven a pendiente. El cron las toma en la siguiente corrida (cada 5 minutos).`); loadTasks(); }
    else alert('Error: ' + res.error);
  }

  async function submitCsv(dryRun: boolean) {
    if (!csvText.trim()) return alert('Carga o pega un CSV primero.');
    if (!dryRun) {
      if (csvEffective === 'price' && (!csvRunAt || !csvRevertAt)) return alert('Elige la fecha de inicio y la de fin de la promo.');
      if (csvEffective !== 'price' && !csvRunAt) return alert('Elige la fecha y hora.');
      if (csvEffective === 'price' && new Date(csvRevertAt) <= new Date(csvRunAt)) return alert('La fecha de fin debe ser posterior a la de inicio.');
      if (!confirm('¿Programar las tareas del CSV? Conviene haber visto antes el resultado de "Revisar".')) return;
    }

    setCsvBusy(true);
    const res = await fetch('/api/scheduler/tasks/csv', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storeKey, csv: csvText, locationId, dryRun,
        action: csvAction, mode: csvMode,
        runAt: csvRunAt ? toIso(csvRunAt) : null,
        revertAt: csvRevertAt ? toIso(csvRevertAt) : null,
      }),
    }).then(r => r.json()).catch(() => ({ ok: false, error: 'Error de red o tiempo agotado. Prueba con un CSV más corto.' }));
    setCsvBusy(false);
    if (res.ok) { setCsvResult(res); if (!dryRun) loadTasks(); }
    else alert('Error: ' + res.error);
  }

  function downloadTemplate(kind: 'price' | 'inventory' | 'publish') {
    const esc = (v: string | number | null | undefined) => {
      const t = String(v ?? '');
      return /[",\n;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    let header: string[] = [];
    const lines: string[] = [];
    if (kind === 'publish') {
      header = ['Handle', 'Title'];
      for (const p of products) {
        if (p.status === 'active') continue; // solo los que aún no están publicados
        lines.push([p.handle || '', p.title].map(esc).join(','));
      }
    } else if (kind === 'inventory') {
      header = ['Handle', 'Title', 'Option1 Value', 'Option2 Value', 'quantity'];
      for (const p of products) for (const v of p.variants) {
        const [o1 = '', o2 = ''] = (v.title || '').split(' / ');
        lines.push([p.handle || '', p.title, o1, o2, ''].map(esc).join(','));
      }
    } else {
      header = ['Handle', 'Title', 'Option1 Value', 'Option2 Value', 'Variant Price', 'Variant Compare At Price'];
      for (const p of products) for (const v of p.variants) {
        const [o1 = '', o2 = ''] = (v.title || '').split(' / ');
        lines.push([p.handle || '', p.title, o1, o2, '', v.price].map(esc).join(','));
      }
    }
    const blob = new Blob(['\uFEFF' + [header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `plantilla-${kind}-${storeKey || 'tienda'}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function onCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setCsvText(String(reader.result || '')); setCsvResult(null); };
    reader.readAsText(file);
  }

  function finishSchedule(res: any) {
    if (res.ok) {
      setModal(null);
      let msg = res.batches ? `Se programó ${res.batches} tarea con ${res.created} cambio(s) adentro.` : `${res.created} tarea(s) programada(s).`;
      if (res.errors?.length) msg += ` ${res.errors.length} con error: ${res.errors.join(', ')}`;
      alert(msg);
      loadTasks();
    } else {
      alert('Error: ' + res.error);
    }
  }

  async function doCancelTask(id: number) {
    if (!confirm('¿Cancelar esta tarea?')) return;
    const res = await fetch('/api/scheduler/tasks/cancel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: id }),
    }).then(r => r.json());
    if (res.ok) loadTasks(); else alert('Error: ' + res.error);
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold">Shopify Scheduler</h1>
        <div className="flex gap-4 text-sm">
          <a href="/stores" className="underline">Tiendas</a>
          <button onClick={logout} className="text-red-600 underline">Salir</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        {stores.map(s => (
          <div key={s.key} className="flex items-center gap-2 bg-white shadow rounded-lg px-3 py-2 text-sm">
            <span className={`w-2.5 h-2.5 rounded-full ${
              s.state === 'connected' ? 'bg-green-600' :
              s.state === 'expiring_soon' ? 'bg-yellow-500' :
              s.state === 'expired' ? 'bg-red-600' : 'bg-gray-400'
            }`} />
            <span>{s.name} — {s.state === 'connected' ? 'Conectada' : s.state === 'expiring_soon' ? 'Token por vencer' : s.state === 'expired' ? 'Token vencido' : 'No conectada'}</span>
            <a href={`/api/scheduler/oauth/install?store=${s.key}`}>
              <button className="px-2 py-1 bg-black text-white rounded text-xs">
                {s.state === 'not_connected' ? 'Conectar' : 'Reconectar'}
              </button>
            </a>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 bg-white shadow rounded-lg p-4 flex-wrap">
        <label>Tienda:
          <select value={storeKey} onChange={e => setStoreKey(e.target.value)} className="ml-2 border rounded px-2 py-1">
            <option value="">-- Selecciona --</option>
            {stores.map(s => <option key={s.key} value={s.key} disabled={s.state === 'not_connected'}>{s.name}{s.state === 'not_connected' ? ' (no conectada)' : ''}</option>)}
          </select>
        </label>
        <label>Sucursal:
          <select value={locationId} onChange={e => setLocationId(e.target.value)} disabled={!storeKey || loadingLocations} className="ml-2 border rounded px-2 py-1 disabled:opacity-40">
            <option value="">{loadingLocations ? 'Cargando...' : '-- Selecciona --'}</option>
            {locations.map(l => <option key={l.id} value={l.id}>{l.name}{!l.active ? ' (inactiva)' : ''}</option>)}
          </select>
        </label>
        <button disabled={!storeKey || !locationId || syncing} onClick={doSync} className="px-3 py-1.5 bg-black text-white rounded disabled:opacity-40">Sincronizar productos</button>
        <button disabled={!storeKey || !locationId} onClick={() => { setCsvResult(null); setCsvText(''); setModal('csv'); }} className="px-3 py-1.5 bg-gray-700 text-white rounded disabled:opacity-40">Importar CSV</button>
        <span className="text-xs text-gray-500">{syncMsg}</span>
        {!stores.length && <span className="text-xs text-red-600">No hay tiendas — ve a "Tiendas" y agrega una.</span>}
        {storeKey && !locationId && !loadingLocations && <span className="text-xs text-gray-500">Elige una sucursal para ver los productos.</span>}
      </div>

      {storeKey && (
        <div className="flex items-end gap-3 bg-white shadow rounded-lg p-4 flex-wrap">
          <strong className="text-sm self-center">Publicar tema</strong>
          <label className="text-sm">Tema (copia lista para publicar)
            <select value={themeId} onChange={e => setThemeId(e.target.value)} className="block border rounded px-2 py-1 mt-1">
              <option value="">-- Selecciona --</option>
              {themes.filter(t => t.role !== 'MAIN').map(t => (
                <option key={t.id} value={t.id}>{t.name} ({t.role.toLowerCase()})</option>
              ))}
            </select>
          </label>
          <label className="text-sm">Fecha y hora
            <input type="datetime-local" value={themeRunAt} onChange={e => setThemeRunAt(e.target.value)} className="block border rounded px-2 py-1 mt-1" />
          </label>
          <button disabled={!themeId || !themeRunAt} onClick={submitTheme} className="px-3 py-1.5 bg-black text-white rounded text-sm disabled:opacity-40">Programar publicación</button>
          {(() => { const main = themes.find(t => t.role === 'MAIN'); return main ? <span className="text-xs text-gray-500">Publicado ahora: {main.name}</span> : null; })()}
          {themesMsg && <span className="text-xs text-red-600">{themesMsg}</span>}
        </div>
      )}

      {(selectedProducts.size > 0 || selectedVariants.size > 0) && (
        <div className="flex items-center gap-3 bg-white shadow rounded-lg p-4">
          <strong className="text-sm">{selectedProducts.size} producto(s), {selectedVariants.size} variante(s)</strong>
          <button onClick={() => selectedProducts.size ? setModal('publish') : alert('Selecciona al menos un producto.')} className="px-3 py-1.5 bg-black text-white rounded text-sm">Programar publicación</button>
          <button onClick={() => selectedVariants.size ? openInventoryModal() : alert('Selecciona al menos una variante.')} className="px-3 py-1.5 bg-black text-white rounded text-sm">Programar inventario</button>
          <button onClick={() => selectedVariants.size ? openPriceModal() : alert('Selecciona al menos una variante.')} className="px-3 py-1.5 bg-black text-white rounded text-sm">Programar precio promo</button>
        </div>
      )}

      <div className="flex items-center gap-3">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar producto (nombre o handle)..."
          className="border rounded px-3 py-1.5 text-sm w-72 bg-white" />
        {search && <span className="text-xs text-gray-500">{visibleProducts.length} de {products.length} producto(s)</span>}
      </div>
      <table className="w-full bg-white shadow rounded-lg text-sm">
        <thead className="bg-gray-50">
          <tr><th className="p-2 text-left"><label className="inline-flex items-center gap-1"><input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} /> Todos</label></th><th className="p-2 text-left">Imagen</th><th className="p-2 text-left">Producto</th><th className="p-2 text-left">Estado</th><th className="p-2 text-left">Variantes</th></tr>
        </thead>
        <tbody>
          {products.length === 0 && <tr><td colSpan={5} className="p-3 text-gray-500">Selecciona tienda y sucursal, luego sincroniza.</td></tr>}
          {products.length > 0 && visibleProducts.length === 0 && <tr><td colSpan={5} className="p-3 text-gray-500">Ningún producto coincide con la búsqueda.</td></tr>}
          {visibleProducts.map(p => (
            <tr key={p.id} className="border-t">
              <td className="p-2"><input type="checkbox" checked={selectedProducts.has(p.id)} onChange={() => toggleProduct(p)} /></td>
              <td className="p-2">{p.image_url && <img src={p.image_url} className="w-11 h-11 object-cover rounded" />}</td>
              <td className="p-2">{p.title}</td>
              <td className="p-2">{p.status}</td>
              <td className="p-2">
                {p.variants.map(v => (
                  <div key={v.id} className="text-xs text-gray-600 mb-1">
                    <label className="font-semibold text-gray-900 inline-flex items-center gap-1">
                      <input type="checkbox" checked={selectedVariants.has(v.id)} onChange={() => toggleVariant(v.id)} />
                      {v.title || 'Default Title'}
                    </label>
                    {' — $'}{v.price}{v.compare_at_price ? ` (antes $${v.compare_at_price})` : ''} · Stock: {v.inventory_qty}
                    {v.sku ? ` · SKU: ${v.sku}` : ''}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center gap-3">
        <h2 className="text-xl font-bold">Tareas programadas</h2>
        {tasks.some(t => t.status === 'failed') && (
          <button onClick={() => retryTask()} className="px-3 py-1.5 bg-amber-600 text-white rounded text-xs">
            Reintentar fallidas ({tasks.filter(t => t.status === 'failed').length})
          </button>
        )}
      </div>
      <table className="w-full bg-white shadow rounded-lg text-sm">
        <thead className="bg-gray-50">
          <tr><th className="p-2 text-left">Tienda</th><th className="p-2 text-left">Tipo</th><th className="p-2 text-left">Producto</th><th className="p-2 text-left">Origen</th><th className="p-2 text-left">Ejecuta</th><th className="p-2 text-left">Revierte</th><th className="p-2 text-left">Estado</th><th className="p-2 text-left">Error</th><th></th></tr>
        </thead>
        <tbody>
          {tasks.length === 0 && <tr><td colSpan={9} className="p-3 text-gray-500">No hay tareas.</td></tr>}
          {tasks.map(t => (
            <tr key={t.id} className="border-t">
              <td className="p-2">{t.store_key}</td>
              <td className="p-2">{typeLabels[t.type] || t.type}</td>
              <td className="p-2">{t.label}</td>
              <td className="p-2">{t.source === 'csv' ? 'CSV' : 'Manual'}</td>
              <td className="p-2">{t.run_at}</td>
              <td className="p-2">{t.revert_at || '—'}</td>
              <td className="p-2">{statusLabels[t.status] || t.status}</td>
              <td className="p-2 text-red-600 text-xs max-w-[200px]">{t.last_error}</td>
              <td className="p-2 flex gap-1">
                {['pending', 'active'].includes(t.status) && <button onClick={() => doCancelTask(t.id)} className="px-2 py-1 bg-red-600 text-white rounded text-xs">Cancelar</button>}
                {t.item_count ? <button onClick={() => openDetail(t.id)} className="px-2 py-1 bg-gray-200 rounded text-xs">Detalle</button> : null}
                {t.status === 'failed' && <button onClick={() => retryTask(t.id)} className="px-2 py-1 bg-amber-600 text-white rounded text-xs">Reintentar</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {modal === 'publish' && (
        <Modal onClose={() => setModal(null)} title="Programar publicación">
          <label className="block text-sm mb-3">Fecha y hora
            <input type="datetime-local" value={publishRunAt} onChange={e => setPublishRunAt(e.target.value)} className="block border rounded px-2 py-1 mt-1 w-full" />
          </label>
          <ModalActions onCancel={() => setModal(null)} onSubmit={submitPublish} />
        </Modal>
      )}

      {modal === 'inventory' && (
        <Modal onClose={() => setModal(null)} title="Programar inventario" wide>
          <p className="text-xs text-gray-500 mb-2">Escribe la cantidad en la fila del producto para llenar todas sus variantes, o ajusta una por una. Se programa UNA sola tarea con todo. Modo y fecha aplican a todas.</p>
          <div className="flex items-end gap-2 mb-2 text-xs">
            <label>Cantidad para todas
              <input type="number" min={1} value={bulkQty} onChange={e => setBulkQty(e.target.value)} className="block w-24 border rounded px-1 py-0.5 mt-1" />
            </label>
            <button type="button" disabled={!bulkQty}
              onClick={applyBulkQty}
              className="px-2 py-1 bg-gray-200 rounded disabled:opacity-40">Aplicar a todas</button>
          </div>
          <div className="max-h-64 overflow-y-auto border rounded mb-3">
            <table className="w-full text-xs">
              <thead><tr className="bg-gray-50"><th className="p-1 text-left">Variante</th><th className="p-1 text-left">Stock actual</th><th className="p-1 text-left">Cantidad</th></tr></thead>
              <tbody>
                {selectedGroups.map(g => (
                  <Fragment key={g.pid}>
                    <tr className="bg-gray-100 border-t">
                      <td className="p-1 font-semibold">{g.title} <span className="font-normal text-gray-500">({g.ids.length} variantes)</span></td>
                      <td className="p-1" />
                      <td className="p-1">
                        <input type="number" min={1} placeholder="todas" value={groupQty[g.pid] ?? ''}
                          onChange={e => setGroupQtyFor(g.pid, g.ids, e.target.value)} className="w-20 border rounded px-1 py-0.5" />
                      </td>
                    </tr>
                    {g.ids.map(id => {
                      const v = variantById.get(id)!;
                      return (
                        <tr key={id} className="border-t">
                          <td className="p-1 pl-4">{v.title || 'Default Title'}</td>
                          <td className="p-1">{v.inventory_qty}</td>
                          <td className="p-1"><input type="number" min={1} value={invQty[id] ?? '10'} onChange={e => setInvQty(prev => ({ ...prev, [id]: e.target.value }))} className="w-20 border rounded px-1 py-0.5" /></td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <label className="block text-sm mb-2">Modo
            <select value={invMode} onChange={e => setInvMode(e.target.value as 'add' | 'set')} className="block border rounded px-2 py-1 mt-1 w-full">
              <option value="add">Sumar al inventario actual</option>
              <option value="set">Fijar como total exacto</option>
            </select>
          </label>
          <label className="block text-sm mb-3">Fecha y hora
            <input type="datetime-local" value={invRunAt} onChange={e => setInvRunAt(e.target.value)} className="block border rounded px-2 py-1 mt-1 w-full" />
          </label>
          <ModalActions onCancel={() => setModal(null)} onSubmit={submitInventory} />
        </Modal>
      )}

      {modal === 'price' && (
        <Modal onClose={() => setModal(null)} title="Programar precio promo" wide>
          <p className="text-xs text-gray-500 mb-2">Escribe el precio en la fila del producto para llenar todas sus variantes, o ajusta una por una. El tachado viene con el precio actual. Se programa UNA sola tarea con todo; las fechas aplican a todas.</p>
          <div className="flex items-end gap-2 mb-2 text-xs flex-wrap">
            <label>Promo para todas
              <input type="number" step="0.01" value={bulkPromo} onChange={e => setBulkPromo(e.target.value)} className="block w-24 border rounded px-1 py-0.5 mt-1" />
            </label>
            <label>Tachado para todas (opcional)
              <input type="number" step="0.01" value={bulkCompare} onChange={e => setBulkCompare(e.target.value)} className="block w-24 border rounded px-1 py-0.5 mt-1" />
            </label>
            <button type="button" disabled={!bulkPromo && !bulkCompare}
              onClick={applyBulkPrice}
              className="px-2 py-1 bg-gray-200 rounded disabled:opacity-40">Aplicar a todas</button>
          </div>
          <div className="max-h-64 overflow-y-auto border rounded mb-3">
            <table className="w-full text-xs">
              <thead><tr className="bg-gray-50"><th className="p-1 text-left">Variante</th><th className="p-1 text-left">Actual</th><th className="p-1 text-left">Promo</th><th className="p-1 text-left">Tachado</th></tr></thead>
              <tbody>
                {selectedGroups.map(g => (
                  <Fragment key={g.pid}>
                    <tr className="bg-gray-100 border-t">
                      <td className="p-1 font-semibold">{g.title} <span className="font-normal text-gray-500">({g.ids.length} variantes)</span></td>
                      <td className="p-1" />
                      <td className="p-1">
                        <input type="number" step="0.01" placeholder="todas" value={groupVals[g.pid]?.promo ?? ''}
                          onChange={e => setGroupPrice(g.pid, g.ids, 'promo', e.target.value)} className="w-20 border rounded px-1 py-0.5" />
                      </td>
                      <td className="p-1">
                        <input type="number" step="0.01" placeholder="actual" value={groupVals[g.pid]?.compare ?? ''}
                          onChange={e => setGroupPrice(g.pid, g.ids, 'compare', e.target.value)} className="w-20 border rounded px-1 py-0.5" />
                      </td>
                    </tr>
                    {g.ids.map(id => {
                      const v = variantById.get(id)!;
                      return (
                        <tr key={id} className="border-t">
                          <td className="p-1 pl-4">{v.title || 'Default Title'}</td>
                          <td className="p-1">${v.price}</td>
                          <td className="p-1"><input type="number" step="0.01" placeholder="ej. 79.00" value={priceVals[id]?.promo ?? ''} onChange={e => setPriceVals(prev => ({ ...prev, [id]: { ...prev[id], promo: e.target.value } }))} className="w-20 border rounded px-1 py-0.5" /></td>
                          <td className="p-1"><input type="number" step="0.01" value={priceVals[id]?.compare ?? String(v.price)} onChange={e => setPriceVals(prev => ({ ...prev, [id]: { ...prev[id], compare: e.target.value } }))} className="w-20 border rounded px-1 py-0.5" /></td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <label className="block text-sm mb-2">Inicia
            <input type="datetime-local" value={priceStart} onChange={e => setPriceStart(e.target.value)} className="block border rounded px-2 py-1 mt-1 w-full" />
          </label>
          <label className="block text-sm mb-3">Termina (revierte solo)
            <input type="datetime-local" value={priceEnd} onChange={e => setPriceEnd(e.target.value)} className="block border rounded px-2 py-1 mt-1 w-full" />
          </label>
          <ModalActions onCancel={() => setModal(null)} onSubmit={submitPrice} />
        </Modal>
      )}

      {modal === 'detail' && detail && (
        <Modal onClose={() => setModal(null)} title={detail.task.label || 'Detalle de la tarea'} wide>
          <p className="text-xs text-gray-500 mb-2">
            Estado: {statusLabels[detail.task.status] || detail.task.status}
            {detail.task.mode ? ` · Modo: ${detail.task.mode === 'set' ? 'fijar' : 'sumar'}` : ''}
            {detail.task.end_mode ? ` · Al terminar: ${detail.task.end_mode === 'compare_to_price' ? 'el precio de comparación pasa a ser el precio real' : 'vuelve al precio anterior'}` : ''}
            {detail.task.pending_blocks ? ` · Pendiente de aplicar: ${detail.task.pending_blocks} bloque(s)` : ''}
          </p>
          {detail.task.last_error && <p className="text-xs text-red-600 mb-2">{detail.task.last_error}</p>}
          <div className="max-h-72 overflow-y-auto border rounded mb-3">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50">
                  <th className="p-1 text-left">{detail.task.type === 'publish_batch' ? 'Producto' : 'Variante'}</th>
                  {detail.task.type === 'price_batch' && <><th className="p-1 text-left">Promo</th><th className="p-1 text-left">Tachado</th></>}
                  {detail.task.type === 'inventory_batch' && <th className="p-1 text-left">Cantidad</th>}
                </tr>
              </thead>
              <tbody>
                {detail.items.map((i: any, k: number) => (
                  <tr key={k} className="border-t">
                    <td className="p-1">{i.label}</td>
                    {detail.task.type === 'price_batch' && <><td className="p-1">${i.promo_price}</td><td className="p-1">${i.compare_at_price}</td></>}
                    {detail.task.type === 'inventory_batch' && <td className="p-1">{i.quantity}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end"><button onClick={() => setModal(null)} className="px-3 py-1.5 bg-gray-200 rounded text-sm">Cerrar</button></div>
        </Modal>
      )}

      {modal === 'csv' && (
        <Modal onClose={() => setModal(null)} title="Importar por CSV" wide>
          <p className="text-xs text-gray-500 mb-2">
            Sube el archivo tal cual y el sistema decide qué hacer según sus columnas: con <code>Variant Price</code> cambia precios,
            con <code>quantity</code> cambia inventario y con solo la lista de productos (<code>Handle</code>) los publica.
            Las fechas las eliges aquí abajo.
          </p>

          <input type="file" accept=".csv,text/csv" onChange={onCsvFile} className="mb-2 text-sm block" />
          <textarea
            value={csvText} onChange={e => { setCsvText(e.target.value); setCsvResult(null); }}
            placeholder="O pega aquí el contenido del CSV..."
            className="w-full h-24 border rounded p-2 text-xs font-mono mb-2"
          />

          <div className="flex items-center gap-2 mb-2 text-sm flex-wrap">
            <span>Acción:</span>
            <select value={csvAction} onChange={e => { setCsvAction(e.target.value as 'auto' | 'price' | 'inventory' | 'publish'); setCsvResult(null); }} className="border rounded px-2 py-1">
              <option value="auto">Automática (según el archivo)</option>
              <option value="price">Forzar: Precio promo</option>
              <option value="inventory">Forzar: Inventario</option>
              <option value="publish">Forzar: Publicar</option>
            </select>
            {csvEffective && (
              <strong className="text-green-700">
                {csvEffective === 'price' ? 'Cambio de precios' : csvEffective === 'inventory' ? 'Cambio de inventario' : 'Publicar productos'}
              </strong>
            )}
          </div>

          {csvEffective === 'price' && (
            <>
              <div className="flex gap-2 mb-1">
                <label className="block text-sm flex-1">Inicia (se aplica el precio del archivo)
                  <input type="datetime-local" value={csvRunAt} onChange={e => setCsvRunAt(e.target.value)} className="block border rounded px-2 py-1 mt-1 w-full" />
                </label>
                <label className="block text-sm flex-1">Termina
                  <input type="datetime-local" value={csvRevertAt} onChange={e => setCsvRevertAt(e.target.value)} className="block border rounded px-2 py-1 mt-1 w-full" />
                </label>
              </div>
              <p className="text-xs text-gray-500 mb-2">
                Al iniciar: el precio pasa a <code>Variant Price</code> y se muestra <code>Variant Compare At Price</code> como tachado
                (si va vacío o en 0, se usa el precio actual como tachado). Al terminar: el precio de comparación pasa a ser el precio real
                y el tachado se quita. Las filas sin precio se omiten.
              </p>
            </>
          )}
          {csvEffective === 'inventory' && (
            <div className="flex gap-2 mb-2">
              <label className="block text-sm flex-1">Fecha y hora
                <input type="datetime-local" value={csvRunAt} onChange={e => setCsvRunAt(e.target.value)} className="block border rounded px-2 py-1 mt-1 w-full" />
              </label>
              <label className="block text-sm flex-1">Modo
                <select value={csvMode} onChange={e => setCsvMode(e.target.value as 'add' | 'set')} className="block border rounded px-2 py-1 mt-1 w-full">
                  <option value="add">Sumar al inventario</option>
                  <option value="set">Fijar como total</option>
                </select>
              </label>
            </div>
          )}
          {csvEffective === 'publish' && (
            <label className="block text-sm mb-2">Fecha y hora de publicación
              <input type="datetime-local" value={csvRunAt} onChange={e => setCsvRunAt(e.target.value)} className="block border rounded px-2 py-1 mt-1 w-full" />
            </label>
          )}
          {csvEffective === 'inventory' && (
            <p className="text-xs text-gray-500 mb-2">Se usa la sucursal elegida arriba ({locationId || 'ninguna'}). Las filas sin cantidad se omiten.</p>
          )}

          <div className="text-xs text-gray-500 mb-2 flex items-center gap-2 flex-wrap">
            <span>Plantillas con tu catálogo:</span>
            <button type="button" disabled={!products.length} onClick={() => downloadTemplate('price')} className="underline disabled:opacity-40">precios</button>
            <button type="button" disabled={!products.length} onClick={() => downloadTemplate('inventory')} className="underline disabled:opacity-40">inventario</button>
            <button type="button" disabled={!products.length} onClick={() => downloadTemplate('publish')} className="underline disabled:opacity-40">publicar</button>
          </div>

          {csvResult && (
            <div className="text-xs mb-3 bg-gray-50 border rounded p-2 max-h-40 overflow-y-auto">
              <p className="font-semibold">
                {csvResult.dryRun ? `Revisión: ${csvResult.created} cambio(s) en ${csvResult.batches ?? 1} tarea(s) (una por acción).` : `Se programó ${csvResult.batches ?? 1} tarea con ${csvResult.created} cambio(s) adentro.`}
                {csvResult.skipped ? ` ${csvResult.skipped} fila(s) omitida(s) (sin valor o repetidas).` : ''}
              </p>
              {csvResult.hint && <p className="text-amber-700 my-1">{csvResult.hint}</p>}
              {csvResult.preview.map((l, i) => <p key={i} className="text-gray-600">· {l}</p>)}
              {csvResult.errors.map((e, i) => <p key={i} className="text-red-600">Fila {e.row}: {e.error}</p>)}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={() => setModal(null)} className="px-3 py-1.5 bg-gray-200 rounded text-sm">Cerrar</button>
            <button disabled={csvBusy || !csvText.trim()} onClick={() => submitCsv(true)} className="px-3 py-1.5 bg-gray-700 text-white rounded text-sm disabled:opacity-40">{csvBusy ? 'Procesando...' : 'Revisar'}</button>
            <button disabled={csvBusy || !csvText.trim()} onClick={() => submitCsv(false)} className="px-3 py-1.5 bg-black text-white rounded text-sm disabled:opacity-40">Programar</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className={`bg-white rounded-lg p-6 ${wide ? 'w-[560px] max-w-[90vw]' : 'w-[340px]'}`}>
        <h3 className="text-lg font-bold mb-3">{title}</h3>
        {children}
      </div>
    </div>
  );
}
function ModalActions({ onCancel, onSubmit, submitLabel }: { onCancel: () => void; onSubmit: () => void; submitLabel?: string }) {
  return (
    <div className="flex justify-end gap-2">
      <button onClick={onCancel} className="px-3 py-1.5 bg-gray-200 rounded text-sm">Cancelar</button>
      <button onClick={onSubmit} className="px-3 py-1.5 bg-black text-white rounded text-sm">{submitLabel || 'Programar'}</button>
    </div>
  );
}
