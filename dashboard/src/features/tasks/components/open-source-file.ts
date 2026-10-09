import { supabase } from '@/lib/supabase'

// A PDF renders in the browser; anything else downloads, so a spreadsheet opens
// in Excel rather than dumping its text into a tab. Storage sets the mimetype
// from the browser's File.type at upload, so a .txt or .csv would otherwise
// always render inline as a wall of text.
export async function openSourceFile(path: string) {
  const filename = path.split('/').pop() ?? 'document'
  const isPdf = filename.toLowerCase().endsWith('.pdf')
  const { data, error } = await supabase.storage
    .from('uploads')
    .createSignedUrl(path, 60 * 60, isPdf ? undefined : { download: filename })
  if (error || !data?.signedUrl) return
  window.open(data.signedUrl, '_blank')
}
