// One type alias, and the reason this package's declaration output is 53x smaller than it was.
//
// THE PROBLEM. An exported `const XSchema = z.strictObject({ ... })` has no type annotation, so
// TypeScript must print the INFERRED type into `dist/*.d.ts` - the whole structural
// `z.ZodObject<{ ... }>` tree. A parent schema that names a child re-prints the child's entire tree
// inside its own, and a grandparent re-prints that. The cost is not linear in the number of
// schemas, it is their nesting depth times their branching: measured on this package, the schema
// constants expanded to 15,146,902 bytes of declarations, of which `ReplayResultSchema` alone was
// 2,239,487 bytes because it inlines four result arms that each re-inline `Verdict`, `StepTrace`
// and `RunEnvelope`. Downstream that cost is paid again on every `tsc` run in every dependent.
//
// THE FIX. TypeScript's declaration printer expands a type ALIAS but prints an INTERFACE BY NAME.
// So a schema whose declared type is an interface appears inside its parents as one identifier
// instead of a subtree. The interface has to be able to name the schema's own inferred type, and an
// `extends` clause takes a type reference rather than a `typeof` query - which is the entire job of
// the alias below.
//
//   const stepSchemaImpl = z.strictObject({ ... });
//   export interface StepSchemaType extends SchemaIdentity<typeof stepSchemaImpl> {}
//   export const StepSchema: StepSchemaType = stepSchemaImpl;
//
// `StepSchemaType` IS the type it extends - not a widening, not a `z.ZodType<T>` erasure.
// `.extend()`, `.shape`, `.parse()`, `.optional()`, `z.infer<>` and use as a `z.discriminatedUnion`
// member all keep working on the exported binding, and the value exported at runtime is the same
// object. The only thing that changes is how the type is PRINTED. Measured, not assumed: after this
// rewrite the rolled-up `dist/index.d.ts` of `@crr/runtime`, `@crr/discovery`, `@crr/surface-browser`
// and `@crr/surface-terminal` were byte-identical to their pre-rewrite selves (same MD5), so nothing
// any dependent exposes changed shape.
//
// WHY NOT the obvious alternatives:
//   · `export const StepSchema: z.ZodType<Step> = ...` erases `.extend()` and `.shape`, and needs a
//     hand-written `Step`, because `type Step = z.infer<typeof StepSchema>` would then be circular.
//   · Hand-writing an interface per document and asserting `z.infer<typeof Schema>` matches it is
//     the same idea with the schema and the type maintained separately - more fidelity risk, and the
//     assertion only catches drift once somebody has already written the shape down twice.
//   · Not exporting the schema constants at all would shrink the file by deleting public API that
//     `test/barrel.test.ts` requires and that `@crr/runtime` and `@crr/discovery` both call.
//
// `test/declaration-size.test.ts` is the regression guard, and it checks BOTH halves: that this
// package's declarations are still small, and that the interface-vs-alias printing difference this
// depends on is still real in the TypeScript version installed.

/**
 * The identity of a type, so an `interface ... extends` clause can name a `typeof` query.
 *
 * `interface I extends typeof x {}` is not syntax; `interface I extends SchemaIdentity<typeof x> {}`
 * is. It resolves to exactly its argument - no widening, no branding, and no runtime value.
 */
export type SchemaIdentity<S> = S;
