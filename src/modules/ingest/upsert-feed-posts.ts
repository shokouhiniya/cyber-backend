import { Repository } from 'typeorm';
import { SelectedPost } from './selected-post.entity';

/**
 * Insert feed posts (official pages / display feed / promise feed); when a post
 * is already stored (unique external_id + source_type + profile_id) refresh only
 * its engagement counts and media URLs — classification, selection_reason and
 * ingest_run_id stay as they were.
 *
 * Counts never go down (a feed page that omits a counter returns 0), and an
 * empty media / avatar URL never wipes a stored one.
 */
export async function upsertFeedPosts(repo: Repository<SelectedPost>, entities: SelectedPost[]): Promise<void> {
  if (entities.length === 0) return;
  await repo
    .createQueryBuilder()
    .insert()
    .into(SelectedPost)
    .values(entities)
    .onConflict(
      `("external_id", "source_type", "profile_id") DO UPDATE SET
        "view_count"        = GREATEST(selected_posts.view_count,    EXCLUDED.view_count),
        "like_count"        = GREATEST(selected_posts.like_count,    EXCLUDED.like_count),
        "reply_count"       = GREATEST(selected_posts.reply_count,   EXCLUDED.reply_count),
        "retweet_count"     = GREATEST(selected_posts.retweet_count, EXCLUDED.retweet_count),
        "media_url"         = COALESCE(NULLIF(EXCLUDED.media_url, ''), selected_posts.media_url),
        "profile_image_url" = COALESCE(NULLIF(EXCLUDED.profile_image_url, ''), selected_posts.profile_image_url)`,
    )
    .execute();
}
