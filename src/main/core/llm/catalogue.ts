/**
 * Catalogue normalisation and filtering live in `shared/` because the settings renderer
 * filters the list as the user types, and the main process filters it again when
 * resolving. Two implementations would be two behaviours.
 */
export {
  filterCatalogue,
  normaliseCatalogue,
  pricePerMillion,
  sortCatalogue
} from '@shared/catalogue'
export type { CatalogueEntry } from '@shared/catalogue'
