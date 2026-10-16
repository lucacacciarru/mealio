import { z } from 'zod'

export const PLAN_IMPORT_SLOTS = [
  'breakfast',
  'morning_snack',
  'lunch',
  'afternoon_snack',
  'dinner',
] as const

const slotSchema = z.enum(PLAN_IMPORT_SLOTS)
const pageSchema = z.number().int().min(1).max(1000).nullable()
const nullableText = (max: number) => z.string().max(max).nullable()
const warningsSchema = z.array(z.string().min(1).max(400)).max(20)

const modelComponentSchema = z
  .object({
    label: z.string().min(1).max(300),
    quantityText: nullableText(100),
    unitText: nullableText(80),
    state: z.enum(['raw', 'cooked', 'unspecified']),
    alternativeGroup: nullableText(100),
    page: pageSchema,
    quote: nullableText(1200),
    notes: nullableText(1000),
    warnings: warningsSchema,
  })
  .strict()

const modelMealSchema = z
  .object({
    slot: slotSchema,
    page: pageSchema,
    quote: nullableText(1200),
    notes: nullableText(2000),
    warnings: warningsSchema,
    components: z.array(modelComponentSchema).max(40),
  })
  .strict()

const modelDaySchema = z
  .object({
    dayIndex: z.number().int().min(0).max(6),
    meals: z.array(modelMealSchema).length(5),
  })
  .strict()

const modelEquivalenceItemSchema = z
  .object({
    label: z.string().min(1).max(300),
    quantityText: nullableText(100),
    unitText: nullableText(80),
    page: pageSchema,
    quote: nullableText(1200),
    warnings: warningsSchema,
  })
  .strict()

const modelEquivalenceSchema = z
  .object({
    scope: z
      .object({
        dayIndex: z.number().int().min(0).max(6).nullable(),
        slot: slotSchema.nullable(),
        componentIndex: z.number().int().min(0).max(39).nullable(),
      })
      .strict(),
    page: pageSchema,
    quote: nullableText(1200),
    note: nullableText(1000),
    warnings: warningsSchema,
    items: z.array(modelEquivalenceItemSchema).max(40),
  })
  .strict()

export const PlanExtractionOutputSchema = z
  .object({
    days: z.array(modelDaySchema).length(7),
    equivalences: z.array(modelEquivalenceSchema).max(100),
    warnings: warningsSchema,
  })
  .strict()

export const PlanExtractionSchema = PlanExtractionOutputSchema.superRefine((extraction, context) => {
  const seenDays = new Set<number>()
  extraction.days.forEach((day, dayPosition) => {
    if (seenDays.has(day.dayIndex)) {
      context.addIssue({
        code: 'custom',
        path: ['days', dayPosition, 'dayIndex'],
        message: 'Giorno duplicato.',
      })
    }
    seenDays.add(day.dayIndex)
    const seenSlots = new Set<string>()
    day.meals.forEach((meal, mealPosition) => {
      if (seenSlots.has(meal.slot)) {
        context.addIssue({
          code: 'custom',
          path: ['days', dayPosition, 'meals', mealPosition, 'slot'],
          message: 'Pasto duplicato nel giorno.',
        })
      }
      seenSlots.add(meal.slot)
    })
  })
  if (seenDays.size !== 7) {
    context.addIssue({ code: 'custom', path: ['days'], message: 'Servono tutti i sette giorni.' })
  }
  extraction.days.forEach((day, dayPosition) => {
    if (new Set(day.meals.map((meal) => meal.slot)).size !== 5) {
      context.addIssue({
        code: 'custom',
        path: ['days', dayPosition, 'meals'],
        message: 'Servono cinque pasti distinti per giorno.',
      })
    }
  })
})

const reviewedComponentFields = z
  .object({
    label: z.string().max(300),
    quantityText: nullableText(100),
    unitText: nullableText(80),
    state: z.enum(['raw', 'cooked', 'unspecified']),
    alternativeGroup: nullableText(100),
    page: pageSchema,
    quote: nullableText(1200),
    notes: nullableText(1000),
    foodId: z.number().int().positive().nullable(),
  })
  .strict()

const reviewedComponentSchema = z
  .object({
    source: modelComponentSchema.nullable(),
    review: reviewedComponentFields,
    removed: z.boolean(),
  })
  .strict()

const modelMealSourceSchema = z
  .object({
    page: pageSchema,
    quote: nullableText(1200),
    notes: nullableText(2000),
    warnings: warningsSchema,
  })
  .strict()

const reviewedMealSchema = z
  .object({
    slot: slotSchema,
    source: modelMealSourceSchema,
    review: z
      .object({
        page: pageSchema,
        quote: nullableText(1200),
        notes: nullableText(2000),
      })
      .strict(),
    reviewed: z.boolean(),
    components: z.array(reviewedComponentSchema).max(40),
  })
  .strict()

const reviewedDaySchema = z
  .object({
    dayIndex: z.number().int().min(0).max(6),
    meals: z.array(reviewedMealSchema).length(5),
  })
  .strict()

const reviewedEquivalenceItemSchema = z
  .object({
    source: modelEquivalenceItemSchema.nullable(),
    review: reviewedComponentFields
      .pick({ label: true, quantityText: true, unitText: true, foodId: true })
      .extend({ page: pageSchema, quote: nullableText(1200) })
      .strict(),
    removed: z.boolean(),
  })
  .strict()

const modelEquivalenceSourceSchema = modelEquivalenceSchema.omit({ items: true })

const reviewedEquivalenceSchema = z
  .object({
    source: modelEquivalenceSourceSchema.nullable(),
    review: z
      .object({
        scope: modelEquivalenceSchema.shape.scope,
        page: pageSchema,
        quote: nullableText(1200),
        note: nullableText(1000),
        items: z.array(reviewedEquivalenceItemSchema).max(40),
      })
      .strict(),
    reviewed: z.boolean(),
    removed: z.boolean(),
  })
  .strict()

export const PlanReviewSchema = z
  .object({
    days: z.array(reviewedDaySchema).length(7),
    equivalences: z.array(reviewedEquivalenceSchema).max(100),
    warnings: warningsSchema,
  })
  .strict()
  .superRefine((review, context) => {
    const seenDays = new Set<number>()
    review.days.forEach((day, dayPosition) => {
      if (seenDays.has(day.dayIndex)) {
        context.addIssue({
          code: 'custom',
          path: ['days', dayPosition, 'dayIndex'],
          message: 'Giorno duplicato.',
        })
      }
      seenDays.add(day.dayIndex)
      if (new Set(day.meals.map((meal) => meal.slot)).size !== 5) {
        context.addIssue({
          code: 'custom',
          path: ['days', dayPosition, 'meals'],
          message: 'Servono cinque pasti distinti per giorno.',
        })
      }
    })
    if (seenDays.size !== 7) {
      context.addIssue({ code: 'custom', path: ['days'], message: 'Servono tutti i sette giorni.' })
    }
  })

export type PlanExtraction = z.infer<typeof PlanExtractionSchema>
export type PlanReview = z.infer<typeof PlanReviewSchema>
export type PlanReviewComponent = PlanReview['days'][number]['meals'][number]['components'][number]
