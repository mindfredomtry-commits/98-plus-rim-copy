export const AUTHORITY_DOCUMENTS = {
  productSpecification: "MVP8_PRODUCT_SPECIFICATION",
  stateRegistry: "MVP8_PRODUCT_CONTROL_STATE_REGISTRY",
  eventRegistry: "MVP8_EVENT_REGISTRY",
  matrix: "MVP8_STATE_EVENT_MATRIX",
} as const;

export const PRODUCT_SPECIFICATION_SOURCE = {
  document: AUTHORITY_DOCUMENTS.productSpecification,
  file: "1. MVP8_PRODUCT SPECIFICATION",
  revision: "8",
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
