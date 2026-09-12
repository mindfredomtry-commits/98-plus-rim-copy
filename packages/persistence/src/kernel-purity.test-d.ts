import type { reduce } from "@98plus/product-model";

type Assert<T extends true> = T;

export type ReduceIsSynchronous = Assert<
  ReturnType<typeof reduce> extends Promise<unknown> ? false : true
>;
