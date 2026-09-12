export const AUTHORITY_DOCUMENTS = {
  productSpecification: "MVP7_PRODUCT_SPECIFICATION",
  stateRegistry: "MVP7_PRODUCT_CONTROL_STATE_REGISTRY",
  eventRegistry: "MVP7_EVENT_REGISTRY",
  matrix: "MVP7_STATE_EVENT_MATRIX",
} as const;

export const PRODUCT_SPECIFICATION_SOURCE = {
  document: AUTHORITY_DOCUMENTS.productSpecification,
  file: "1. MVP7_PRODUCT SPECIFICATION",
  revision: "7",
} as const;

export type AuthorityDocument = (typeof AUTHORITY_DOCUMENTS)[keyof typeof AUTHORITY_DOCUMENTS];

export type AuthorityReference = Readonly<{
  document: AuthorityDocument;
  locator: string;
  rule?: string;
  note?: string;
}>;

export type ReferencedDefinition = Readonly<{
  references: readonly [AuthorityReference, ...AuthorityReference[]];
}>;
