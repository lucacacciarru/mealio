import { asc, eq, or, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  catalogAisles,
  catalogFoodAliases,
  catalogFoods,
  catalogUnits,
} from '../db/schema'

// Foods are normalized once in the catalog. Canonical names are unique
// case-insensitively at the application level; aliases are stored lowercase.
// Nutrients and food state belong to the macro phase and are not modeled here.

function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase()
}

export function getOrCreateAisle(name: string): number {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Nome reparto mancante.')
  const existing = db.select().from(catalogAisles).where(eq(catalogAisles.name, trimmed)).get()
  if (existing) return existing.id
  const inserted = db.insert(catalogAisles).values({ name: trimmed }).returning().get()
  return inserted.id
}

export function getOrCreateUnit(symbol: string, name?: string): number {
  const trimmed = symbol.trim()
  if (!trimmed) throw new Error('Simbolo unità mancante.')
  const existing = db
    .select()
    .from(catalogUnits)
    .where(eq(catalogUnits.symbol, trimmed))
    .get()
  if (existing) return existing.id
  const inserted = db.insert(catalogUnits).values({ symbol: trimmed, name }).returning().get()
  return inserted.id
}

export type AddFoodInput = {
  canonicalName: string
  aliases?: string[]
  defaultUnitSymbol?: string
  aisleName?: string
}

export function addFood(input: AddFoodInput): number {
  const canonicalName = input.canonicalName.trim()
  if (!canonicalName) throw new Error('Nome alimento mancante.')
  if (findFoodByText(canonicalName)) {
    throw new Error(`L'alimento "${canonicalName}" esiste già nel catalogo.`)
  }
  const aliases = (input.aliases ?? []).map(normalizeAlias).filter(Boolean)
  for (const alias of aliases) {
    const conflict = findFoodByText(alias)
    if (conflict) {
      throw new Error(`L'alias "${alias}" è già associato a "${conflict.canonicalName}".`)
    }
  }
  return db.transaction(() => {
    const defaultUnitId = input.defaultUnitSymbol
      ? getOrCreateUnit(input.defaultUnitSymbol)
      : null
    const aisleId = input.aisleName ? getOrCreateAisle(input.aisleName) : null
    const food = db
      .insert(catalogFoods)
      .values({
        canonicalName,
        defaultUnitId,
        aisleId,
        createdAt: Date.now(),
      })
      .returning()
      .get()
    for (const alias of aliases) {
      db.insert(catalogFoodAliases).values({ foodId: food.id, alias }).run()
    }
    return food.id
  })
}

export type CatalogFoodRow = {
  id: number
  canonicalName: string
  defaultUnitSymbol: string | null
  aisleName: string | null
  aliases: string[]
}

export function listCatalog(): CatalogFoodRow[] {
  const foods = db.select().from(catalogFoods).orderBy(asc(catalogFoods.canonicalName)).all()
  const unitNames = new Map(
    db.select().from(catalogUnits).all().map((unit) => [unit.id, unit.symbol]),
  )
  const aisleNames = new Map(
    db.select().from(catalogAisles).all().map((aisle) => [aisle.id, aisle.name]),
  )
  const aliases = db.select().from(catalogFoodAliases).orderBy(asc(catalogFoodAliases.alias)).all()
  const aliasesByFood = new Map<number, string[]>()
  for (const row of aliases) {
    const list = aliasesByFood.get(row.foodId) ?? []
    list.push(row.alias)
    aliasesByFood.set(row.foodId, list)
  }
  return foods.map((food) => ({
    id: food.id,
    canonicalName: food.canonicalName,
    defaultUnitSymbol: food.defaultUnitId ? unitNames.get(food.defaultUnitId) ?? null : null,
    aisleName: food.aisleId ? aisleNames.get(food.aisleId) ?? null : null,
    aliases: aliasesByFood.get(food.id) ?? [],
  }))
}

export function findFoodByText(text: string): { id: number; canonicalName: string } | null {
  const normalized = normalizeAlias(text)
  if (!normalized) return null
  const viaAlias = db
    .select({ id: catalogFoods.id, canonicalName: catalogFoods.canonicalName })
    .from(catalogFoodAliases)
    .innerJoin(catalogFoods, eq(catalogFoodAliases.foodId, catalogFoods.id))
    .where(eq(catalogFoodAliases.alias, normalized))
    .get()
  if (viaAlias) return viaAlias
  return (
    db
      .select({ id: catalogFoods.id, canonicalName: catalogFoods.canonicalName })
      .from(catalogFoods)
      .where(
        or(
          eq(catalogFoods.canonicalName, text),
          eq(sql`lower(${catalogFoods.canonicalName})`, normalized),
        ),
      )
      .get() ?? null
  )
}

export function addAlias(foodId: number, alias: string): void {
  const food = db.select().from(catalogFoods).where(eq(catalogFoods.id, foodId)).get()
  if (!food) throw new Error('Alimento del catalogo non trovato.')
  const normalized = normalizeAlias(alias)
  if (!normalized) throw new Error('Alias mancante.')
  db.insert(catalogFoodAliases).values({ foodId, alias: normalized }).run()
}

export function listAisles(): { id: number; name: string }[] {
  return db
    .select({ id: catalogAisles.id, name: catalogAisles.name })
    .from(catalogAisles)
    .orderBy(asc(catalogAisles.position), asc(catalogAisles.name))
    .all()
}

export function listUnits(): { id: number; symbol: string; name: string | null }[] {
  return db
    .select({ id: catalogUnits.id, symbol: catalogUnits.symbol, name: catalogUnits.name })
    .from(catalogUnits)
    .orderBy(asc(catalogUnits.symbol))
    .all()
}
