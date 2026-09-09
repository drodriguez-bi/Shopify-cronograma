'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type StoreOption = {
  id: number; key: string; name: string;
  state: 'connected' | 'expiring_soon' | 'expired' | 'not_connected';
};
type Variant = {
  id: number; variant_id: number; title: string | null; sku: string | null;
  price: string; compare_at_price: string | null; inventory_qty: number;
};
type Product = { id: number; product_id: number; title: string; status: string; image_url: string | null; variants: Variant[] };
type Task = {
  id: number; store_key: string; type: string; label: string | null;
  run_at: string; revert_at: string | null; status: string; last_error: string | null; source: string;
};

const statusLabels: Record<string, string> = { pending: 'Pendiente', active: 'Activa', completed: 'Completada', failed: 'Fallida', cancelled: 'Cancelada' };
const typeLabels: Record<string, string> = { publish: 'Publicación', inventory: 'Inventario', price: 'Precio promo' };

function toIso(datetimeLocal: string): string {
  return new Date(datetimeLocal).toISOString();
}

export default function SchedulerPage() {
  const router = useRouter();
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [storeKey, setStoreKey] = useState('');
  const [locations, setLocations] = useState<{ id: string; name: string; active: boolean }[]>([]);
  const [locationId, setLocationId] = useState('');
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<Set<number>>(new Set());
  const [selectedVariants, setSelectedVariants] = useState<Set<number>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);

  const [modal, setModal] = useState<null | 'publish' | 'inventory' | 'price' | 'csv'>(null);
  const [publishRunAt, setPublishRunAt] = useState('');
  const [invMode, setInvMode] = useState<'add' | 'set'>('add');
  const [invRunAt, setInvRunAt] = useState('');
  const [invQty, setInvQty] = useState<Record<number, string>>({});
  const [priceStart, setPriceStart] = useState('');
  const [priceEnd, setPriceEnd] = useState('');
  const [priceVals, setPriceVals] = useState<Record<number, { promo: string; compare: string }>>({});
  const [csvText, setCsvText] = useState('');
  const [csvResult, setCsvResult] = useState<{ created: number; errors: { row: number; error: string }[] } | null>(null);

  const variantById = new Map<number, Variant & { productTitle: string }>();
  products.forEach(p => p.variants.forEach(v => variantById.set(v.id, { ...v, productTitle: p.title })));

  useEffect(() => { loadStores(); loadTasks(); }, []);
  useEffect(() => {
    setLocationId('');
    setLocations([]);
    setProducts([]);
    if (storeKey) loadLocations(storeKey);
  }, [storeKey]);
  useEffect(() => { if (storeKey && locationId) loadProducts(storeKey); else setProducts([]); }, [storeKey, locationId]);

  async function loadStores() {
    const res = await fetch('/api/scheduler/stores').then(r => r.json());
    if (res.ok) setStores(res.stores);
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

  function toggleProduct(id: number) {
    setSelectedProducts(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
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

  async function submitInventory() {
    if (!invRunAt) return alert('Selecciona fecha y hora.');
    const items = [...selectedVariants].map(id => ({
      variantCacheId: id,
      label: `${variantById.get(id)?.productTitle} — ${variantById.get(id)?.title || 'Default Title'}`,
      quantity: parseInt(invQty[id] || '0', 10),
    }));
    if (items.some(i => !i.quantity || i.quantity <= 0)) return alert('Falta cantidad válida en alguna variante.');
    const res = await fetch('/api/scheduler/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'schedule_inventory', storeKey, runAt: toIso(invRunAt), mode: invMode, locationId, items }),
    }).then(r => r.json());
    finishSchedule(res);
  }

  async function submitPrice() {
    if (!priceStart || !priceEnd) return alert('Completa las fechas de inicio y fin.');
    if (new Date(priceEnd) <= new Date(priceStart)) return alert('La fecha de fin debe ser posterior a la de inicio.');
    const items = [...selectedVariants].map(id => ({
      variantCacheId: id,
      label: `${variantById.get(id)?.productTitle} — ${variantById.get(id)?.title || 'Default Title'}`,
      promoPrice: parseFloat(priceVals[id]?.promo || '0'),
      compareAtPrice: parseFloat(priceVals[id]?.compare || '0'),
    }));
    if (items.some(i => !i.promoPrice || !i.compareAtPrice)) return alert('Falta precio promocional o tachado en alguna variante.');
    const res = await fetch('/api/scheduler/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'schedule_price', storeKey, runAt: toIso(priceStart), revertAt: toIso(priceEnd), items }),
    }).then(r => r.json());
    finishSchedule(res);
  }

  async function submitCsv() {
    if (!csvText.trim()) return alert('Pega o carga un CSV primero.');
    const res = await fetch('/api/scheduler/tasks/csv', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeKey, csv: csvText, locationId }),
    }).then(r => r.json());
    if (res.ok) { setCsvResult(res); loadTasks(); }
    else alert('Error: ' + res.error);
  }

  function onCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setCsvText(String(reader.result || ''));
    reader.readAsText(file);
  }

  function finishSchedule(res: any) {
    if (res.ok) {
      setModal(null);
      let msg = `${res.created} tarea(s) programada(s).`;
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

      {(selectedProducts.size > 0 || selectedVariants.size > 0) && (
        <div className="flex items-center gap-3 bg-white shadow rounded-lg p-4">
          <strong className="text-sm">{selectedProducts.size} producto(s), {selectedVariants.size} variante(s)</strong>
          <button onClick={() => selectedProducts.size ? setModal('publish') : alert('Selecciona al menos un producto.')} className="px-3 py-1.5 bg-black text-white rounded text-sm">Programar publicación</button>
          <button onClick={() => selectedVariants.size ? setModal('inventory') : alert('Selecciona al menos una variante.')} className="px-3 py-1.5 bg-black text-white rounded text-sm">Programar inventario</button>
          <button onClick={() => selectedVariants.size ? setModal('price') : alert('Selecciona al menos una variante.')} className="px-3 py-1.5 bg-black text-white rounded text-sm">Programar precio promo</button>
        </div>
      )}

      <table className="w-full bg-white shadow rounded-lg text-sm">
        <thead className="bg-gray-50">
          <tr><th className="p-2 text-left">Publicar</th><th className="p-2 text-left">Imagen</th><th className="p-2 text-left">Producto</th><th className="p-2 text-left">Estado</th><th className="p-2 text-left">Variantes</th></tr>
        </thead>
        <tbody>
          {products.length === 0 && <tr><td colSpan={5} className="p-3 text-gray-500">Selecciona tienda y sucursal, luego sincroniza.</td></tr>}
          {products.map(p => (
            <tr key={p.id} className="border-t">
              <td className="p-2"><input type="checkbox" checked={selectedProducts.has(p.id)} onChange={() => toggleProduct(p.id)} /></td>
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

      <h2 className="text-xl font-bold">Tareas programadas</h2>
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
              <td className="p-2">{['pending', 'active'].includes(t.status) && <button onClick={() => doCancelTask(t.id)} className="px-2 py-1 bg-red-600 text-white rounded text-xs">Cancelar</button>}</td>
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
          <p className="text-xs text-gray-500 mb-2">Cantidad individual por variante. Modo y fecha aplican a todas.</p>
          <div className="max-h-64 overflow-y-auto border rounded mb-3">
            <table className="w-full text-xs">
              <thead><tr className="bg-gray-50"><th className="p-1 text-left">Variante</th><th className="p-1 text-left">Stock actual</th><th className="p-1 text-left">Cantidad</th></tr></thead>
              <tbody>
                {[...selectedVariants].map(id => {
                  const v = variantById.get(id)!;
                  return (
                    <tr key={id} className="border-t">
                      <td className="p-1">{v.productTitle} — {v.title || 'Default Title'}</td>
                      <td className="p-1">{v.inventory_qty}</td>
                      <td className="p-1"><input type="number" min={1} defaultValue={10} onChange={e => setInvQty(prev => ({ ...prev, [id]: e.target.value }))} className="w-20 border rounded px-1 py-0.5" /></td>
                    </tr>
                  );
                })}
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
          <p className="text-xs text-gray-500 mb-2">Precio individual por variante. Fechas aplican a todas.</p>
          <div className="max-h-64 overflow-y-auto border rounded mb-3">
            <table className="w-full text-xs">
              <thead><tr className="bg-gray-50"><th className="p-1 text-left">Variante</th><th className="p-1 text-left">Actual</th><th className="p-1 text-left">Promo</th><th className="p-1 text-left">Tachado</th></tr></thead>
              <tbody>
                {[...selectedVariants].map(id => {
                  const v = variantById.get(id)!;
                  return (
                    <tr key={id} className="border-t">
                      <td className="p-1">{v.productTitle} — {v.title || 'Default Title'}</td>
                      <td className="p-1">${v.price}</td>
                      <td className="p-1"><input type="number" step="0.01" placeholder="ej. 79.00" onChange={e => setPriceVals(prev => ({ ...prev, [id]: { ...prev[id], promo: e.target.value } }))} className="w-20 border rounded px-1 py-0.5" /></td>
                      <td className="p-1"><input type="number" step="0.01" defaultValue={v.price} onChange={e => setPriceVals(prev => ({ ...prev, [id]: { ...prev[id], compare: e.target.value } }))} className="w-20 border rounded px-1 py-0.5" /></td>
                    </tr>
                  );
                })}
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

      {modal === 'csv' && (
        <Modal onClose={() => setModal(null)} title="Importar tareas por CSV" wide>
          <p className="text-xs text-gray-500 mb-2">
            Encabezados: <code>type,sku,run_at,revert_at,quantity,mode,location_id,promo_price,compare_at_price,label</code>.
            {' '}<code>location_id</code> es opcional para <code>inventory</code> (si lo dejas vacío, usa la sucursal seleccionada arriba: {locationId || 'ninguna elegida'}).
            <code>run_at</code>/<code>revert_at</code> en formato ISO con zona horaria, ej.{' '}
            <code>2026-07-10T15:00:00-06:00</code>. Deja vacías las columnas que no apliquen a cada fila.
            El SKU se busca en el catálogo ya sincronizado de esta tienda.
          </p>
          <input type="file" accept=".csv,text/csv" onChange={onCsvFile} className="mb-2 text-sm" />
          <textarea
            value={csvText} onChange={e => setCsvText(e.target.value)}
            placeholder="O pega aquí el contenido del CSV..."
            className="w-full h-40 border rounded p-2 text-xs font-mono mb-3"
          />
          {csvResult && (
            <div className="text-xs mb-3 bg-gray-50 border rounded p-2 max-h-32 overflow-y-auto">
              <p className="font-semibold">{csvResult.created} tarea(s) creada(s).</p>
              {csvResult.errors.map((e, i) => <p key={i} className="text-red-600">Fila {e.row}: {e.error}</p>)}
            </div>
          )}
          <ModalActions onCancel={() => setModal(null)} onSubmit={submitCsv} submitLabel="Importar" />
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
