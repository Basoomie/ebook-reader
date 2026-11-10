/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import CollectionActionsDialog, {
  type CollectionAction
} from '$lib/components/collections/collection-actions-dialog.svelte';
import CollectionDeleteDialog from '$lib/components/collections/collection-delete-dialog.svelte';
import CollectionEditDialog from '$lib/components/collections/collection-edit-dialog.svelte';
import { dialogManager, type Dialog } from '$lib/data/dialog-manager';
import type { CollectionsApi } from '$lib/sync/sync-service';
import type { Collection, CollectionType } from './collections';

/**
 * The dialog flows shared by the Collections page and a collection's own view (WP8b):
 * new collection, the "⋯" actions, rename, change the search, delete.
 */

function ask<T>(component: Dialog['component'], props: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve) => {
    dialogManager.dialogs$.next([
      { component, disableCloseOnClick: true, props: { ...props, resolver: resolve } }
    ]);
  });
}

/** New collection; resolves to its id, or undefined when canceled. */
export function newCollection(
  api: CollectionsApi,
  preset: { type?: CollectionType; query?: string; chooseType?: boolean } = {}
): Promise<string | undefined> {
  return ask<string | undefined>(CollectionEditDialog, {
    mode: 'new',
    type: preset.type ?? 'manual',
    query: preset.query ?? '',
    chooseType: preset.chooseType ?? true,
    save: (v: { name: string; type: CollectionType; query: string }) =>
      api.create({ name: v.name, type: v.type, query: v.type === 'smart' ? v.query : null })
  });
}

/** The "⋯" of a collection. Resolves to 'deleted' when it was deleted. */
export async function collectionMenu(
  api: CollectionsApi,
  collection: Collection
): Promise<CollectionAction | 'deleted' | undefined> {
  const action = await ask<CollectionAction | undefined>(CollectionActionsDialog, {
    name: collection.name,
    type: collection.type
  });
  if (action === 'rename') {
    await ask(CollectionEditDialog, {
      mode: 'rename',
      name: collection.name,
      type: collection.type,
      save: async (v: { name: string }) => {
        await api.rename(collection.id, v.name);
        return collection.id;
      }
    });
  } else if (action === 'search') {
    await ask(CollectionEditDialog, {
      mode: 'search',
      name: collection.name,
      type: 'smart',
      query: collection.query ?? '',
      save: async (v: { query: string }) => {
        await api.setQuery(collection.id, v.query);
        return collection.id;
      }
    });
  } else if (action === 'delete') {
    const confirmed = await ask<boolean>(CollectionDeleteDialog, { name: collection.name });
    if (!confirmed) return undefined;
    await api.remove(collection.id);
    return 'deleted';
  }
  return action;
}
