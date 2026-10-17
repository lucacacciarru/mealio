import type { PlanComponentState } from '../db/schema'

export const SLOT_LABELS = {
  breakfast: 'Colazione',
  morning_snack: 'Spuntino mattutino',
  lunch: 'Pranzo',
  afternoon_snack: 'Spuntino pomeridiano',
  dinner: 'Cena',
} as const

export type FoodFields = {
  label: string
  quantityText: string | null
  unitText: string | null
  state?: PlanComponentState
  notes?: string | null
}

// A food as printed in the plan; missing quantities and an unspecified
// raw/cooked state stay visible instead of being guessed.
export function FoodText({ food }: { food: FoodFields }) {
  const amount = [food.quantityText?.trim(), food.unitText?.trim()].filter(Boolean).join(' ')
  return (
    <span>
      {food.label}
      {amount ? (
        <span className="summary-amount"> {amount}</span>
      ) : (
        <span className="summary-missing"> · quantità non indicata</span>
      )}
      {food.state === 'raw' && <span className="summary-state"> a crudo</span>}
      {food.state === 'cooked' && <span className="summary-state"> a cotto</span>}
      {food.state === 'unspecified' && (
        <span className="summary-missing"> · stato crudo/cotto non specificato</span>
      )}
      {food.notes && <span className="summary-note"> ({food.notes})</span>}
    </span>
  )
}
