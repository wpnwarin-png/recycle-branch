import { useEffect, useRef, useState } from 'react'
import { supabase, isSupabaseReady } from './supabase'

const DEVICE_ID = Math.random().toString(36).slice(2)

const ARRAY_TABLES = {
  purchases: 'purchases',
  sales: 'sales',
  customers: 'customers',
  expenses: 'expenses',
  withdrawals: 'withdrawals',
  deposits: 'deposits',
  prepayments: 'prepayments',
  deliveries: 'deliveries',
  bankTransfers: 'bank_transfers',
  assets: 'assets',
  loans: 'loans',
  dividendPayments: 'dividend_payments',
  storeBankAccounts: 'store_bank_accounts',
  shareholders: 'shareholders',
}

const SETTINGS_KEYS = [
  'shopProfile', 'companySettings', 'unitOptions',
  'expenseCategories', 'productCategories',
]

// ---------- Global sync status ----------
let globalStatus = 'synced'
let pendingCount = 0
const statusListeners = new Set()

function setGlobalStatus(status) {
  globalStatus = status
  statusListeners.forEach(fn => fn(status))
}

function incrementPending() {
  pendingCount++
  setGlobalStatus('saving')
}

function decrementPending(success) {
  pendingCount = Math.max(0, pendingCount - 1)
  if (pendingCount === 0) {
    setGlobalStatus(success ? 'synced' : 'error')
  }
}

export function useSyncStatus() {
  const [status, setStatus] = useState(globalStatus)
  useEffect(() => {
    statusListeners.add(setStatus)
    return () => statusListeners.delete(setStatus)
  }, [])
  return status
}

// ---------- Array table helpers ----------
async function saveArrayTable(tableName, items) {
  if (!isSupabaseReady || !Array.isArray(items) || items.length === 0) return true
  const rows = items.map(item => ({
    id: item.id,
    data: { ...item, _updated_by: DEVICE_ID },
    updated_at: new Date().toISOString(),
  }))
  const BATCH = 50
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const { error } = await supabase.from(tableName).upsert(batch, { onConflict: 'id' })
    if (error) return false
  }
  return true
}

async function deleteArrayRow(tableName, id) {
  if (!isSupabaseReady) return true
  const { error } = await supabase.from(tableName).delete().eq('id', id)
  return !error
}

async function loadArrayTable(tableName) {
  if (!isSupabaseReady) return []
  const PAGE = 1000
  let all = []
  let from = 0
  while (true) {
    let data, error
    // ลองใหม่สูงสุด 3 ครั้งต่อหน้า ก่อนจะยอมแพ้ (กันเน็ตกระตุกทำให้โหลดได้ไม่ครบ)
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await supabase
        .from(tableName)
        .select('data')
        .order('updated_at', { ascending: true })
        .range(from, from + PAGE - 1)
      data = res.data
      error = res.error
      if (!error) break
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
    }
    if (error || !data) {
      // โหลดไม่สำเร็จแม้ retry แล้ว — ห้ามคืนข้อมูลที่โหลดมาไม่ครบเด็ดขาด
      // (เพราะถ้าเอาไปเซ็ตเป็น state แล้วปล่อยให้ sync ทำงานต่อ รายการที่หายไปจากหน้านี้
      // จะถูกตีความว่า "ผู้ใช้ลบ" แล้วไปลบจริงในฐานข้อมูล)
      throw new Error(`โหลดตาราง ${tableName} ไม่สำเร็จ (ได้ ${all.length} รายการ)`)
    }
    all = all.concat(data.map(row => row.data))
    if (data.length < PAGE) break
    from += PAGE
  }
  return all
}

// ---------- Settings helpers ----------
async function saveSettings(key, value) {
  if (!isSupabaseReady) return true
  const { error } = await supabase.from('app_settings').upsert(
    { key, data: { value, _updated_by: DEVICE_ID }, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  )
  return !error
}

async function loadSettings(key) {
  if (!isSupabaseReady) return null
  const { data, error } = await supabase
    .from('app_settings')
    .select('data')
    .eq('key', key)
    .single()
  if (error || !data) return null
  return data.data?.value ?? null
}

// ---------- loadAllFromSupabase ----------
export async function loadAllFromSupabase() {
  if (!isSupabaseReady) return null
  const result = {}
  const failedTables = []
  await Promise.all(
    Object.entries(ARRAY_TABLES).map(async ([stateKey, tableName]) => {
      try {
        result[stateKey] = await loadArrayTable(tableName)
      } catch (e) {
        // โหลดตารางนี้ไม่สำเร็จ — อย่าใส่คีย์นี้ลงใน result เด็ดขาด
        // เพื่อไม่ให้ผู้เรียกเอาข้อมูลไม่ครบไปเซ็ตทับ state เดิมที่ครบถ้วนอยู่แล้ว
        failedTables.push(stateKey)
      }
    })
  )
  await Promise.all(
    SETTINGS_KEYS.map(async (key) => {
      const val = await loadSettings(key)
      if (val !== null) result[key] = val
    })
  )
  if (failedTables.length > 0) result._failedTables = failedTables
  return result
}

// ---------- saveToSupabase (เรียกตรงๆ สำหรับกรณีพิเศษ) ----------
export async function saveToSupabase(key, items) {
  const tableName = ARRAY_TABLES[key]
  if (tableName) return await saveArrayTable(tableName, items)
  if (SETTINGS_KEYS.includes(key)) return await saveSettings(key, items)
}

// ---------- useSupabaseSync ----------
export function useSupabaseSync(key, value, setValue, loaded) {
  const valueRef = useRef(value)
  useEffect(() => { valueRef.current = value }, [value])

  const prevValueRef = useRef(null)
  const saveTimer = useRef(null)
  const maxWaitTimer = useRef(null)
  const isFirstRender = useRef(true)
  const isSaving = useRef(false)

  const tableName = ARRAY_TABLES[key]
  const isArrayTable = !!tableName
  const isSettingsKey = SETTINGS_KEYS.includes(key)

  // ---------- SAVE ----------
  useEffect(() => {
    if (!loaded || !isSupabaseReady) return
    if (isFirstRender.current) {
      isFirstRender.current = false
      prevValueRef.current = value
      return
    }

    const doSave = async () => {
      clearTimeout(saveTimer.current)
      clearTimeout(maxWaitTimer.current)
      saveTimer.current = null
      maxWaitTimer.current = null
      isSaving.current = true

      incrementPending()
      let success = false
      try {
        if (isArrayTable) {
          const current = valueRef.current
          const prev = prevValueRef.current || []
          const prevMap = new Map(prev.filter(x => x.id).map(x => [x.id, JSON.stringify(x)]))
          const changed = current.filter(item => {
            if (!item.id) return true
            return prevMap.get(item.id) !== JSON.stringify(item)
          })
          const currentIds = new Set(current.filter(x => x.id).map(x => x.id))
          let deleted = prev.filter(x => x.id && !currentIds.has(x.id))

          // เซฟตี้: ถ้าจู่ๆ ข้อมูลหายไปทีเดียวจำนวนมาก (เช่น >5 รายการ และเกิน 25% ของของเดิม)
          // มักไม่ใช่ผู้ใช้ลบเองทีละรายการ แต่น่าจะมาจากการโหลดข้อมูลไม่ครบ — ห้ามลบจริงใน DB
          const isSuspiciousMassDelete = deleted.length >= 5 && deleted.length > prev.length * 0.25
          if (isSuspiciousMassDelete) {
            console.warn(`[useSupabaseSync] ข้าม auto-delete ของ "${tableName}": ตรวจพบว่าจะลบ ${deleted.length}/${prev.length} รายการพร้อมกัน ซึ่งดูผิดปกติ (อาจเกิดจากโหลดข้อมูลไม่ครบ) — จะไม่ลบข้อมูลจริงใน Supabase`)
            deleted = []
          }

          let ok = true
          if (changed.length > 0) ok = await saveArrayTable(tableName, changed)
          for (const item of deleted) {
            const r = await deleteArrayRow(tableName, item.id)
            if (!r) ok = false
          }
          success = ok
          prevValueRef.current = [...current]
        } else if (isSettingsKey) {
          success = await saveSettings(key, valueRef.current)
          prevValueRef.current = valueRef.current
        }
      } catch (e) {
        success = false
      } finally {
        isSaving.current = false
        decrementPending(success)
      }
    }

    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(doSave, 2000)
    if (!maxWaitTimer.current) {
      maxWaitTimer.current = setTimeout(doSave, 6000)
    }

    return () => {
      clearTimeout(saveTimer.current)
      // หมายเหตุ: ไม่ clear maxWaitTimer ตรงนี้ — ต้องปล่อยให้มันทำงานต่อแม้ค่าจะเปลี่ยนถี่ๆ
      // (เป็น safety-net ให้เซฟภายใน 6 วิ แม้ debounce 2 วิจะถูกรีเซ็ตซ้ำๆ ก็ตาม)
    }
  }, [key, value, loaded])

  // ---------- REALTIME ----------
  useEffect(() => {
    if (!isSupabaseReady || !loaded) return

    if (isArrayTable) {
      const channel = supabase
        .channel(`rt-${tableName}-${DEVICE_ID}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: tableName }, (payload) => {
          const item = payload.new?.data
          if (!item || item._updated_by === DEVICE_ID) return
          setValue(prev => {
            if (prev.some(x => x.id === item.id)) return prev
            return [...prev, item]
          })
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: tableName }, (payload) => {
          const item = payload.new?.data
          if (!item || item._updated_by === DEVICE_ID) return
          setValue(prev => prev.map(x => x.id === item.id ? item : x))
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: tableName }, (payload) => {
          const id = payload.old?.id
          if (!id) return
          setValue(prev => prev.filter(x => x.id !== id))
        })
        .subscribe()
      return () => { supabase.removeChannel(channel) }
    }

    if (isSettingsKey) {
      const channel = supabase
        .channel(`rt-settings-${key}-${DEVICE_ID}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_settings', filter: `key=eq.${key}` }, (payload) => {
          const updatedBy = payload.new?.data?._updated_by
          if (updatedBy === DEVICE_ID) return
          const newValue = payload.new?.data?.value
          if (newValue !== undefined) setValue(newValue)
        })
        .subscribe()
      return () => { supabase.removeChannel(channel) }
    }
  }, [key, setValue, loaded, tableName, isArrayTable, isSettingsKey])
}
