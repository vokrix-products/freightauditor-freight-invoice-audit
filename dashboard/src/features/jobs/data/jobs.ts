import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/auth-store'
import { supabase, PRODUCT_ID } from '@/lib/supabase'

async function writeAudit(action: string, entity: string, entityId: string, userId: string) {
  try {
    await supabase.from('audit_log').insert({
      product_id: PRODUCT_ID,
      customer_id: userId,
      action,
      entity,
      entity_id: entityId,
    })
  } catch (e) {
    void e
  }
}

export interface Job {
  id: string
  job_type: string
  status: string
  input_file_path: string | null
  input_file_paths: string[] | null
  output_file_path: string | null
  result_summary: Record<string, unknown> | null
  error_message: string | null
  created_at: string
  completed_at: string | null
}

async function fetchJobs(): Promise<Job[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select(
      'id, job_type, status, input_file_path, input_file_paths, output_file_path, result_summary, error_message, created_at, completed_at'
    )
    .eq('product_id', PRODUCT_ID)
    .order('created_at', { ascending: false })

  if (error) throw error
  return data ?? []
}

export function useJobs() {
  return useQuery({
    queryKey: ['jobs', PRODUCT_ID],
    queryFn: fetchJobs,
    refetchInterval: 5000,
  })
}

const TRIAL_LIMIT = 3

// The trial gate used to key off `user.product_id`, a single scalar carried in
// app_metadata. On a multi-product platform that scalar can only hold ONE
// product, so a customer paying for this product *and* another was capped at
// three uploads while the UI showed them as paid. `subscriptions` is keyed per
// (customer_id, product_id) and is the authoritative record.
async function hasActiveSubscription(userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('status')
    .eq('customer_id', userId)
    .eq('product_id', PRODUCT_ID)
    .in('status', ['active', 'trialing'])
    .limit(1)
  if (error) return false
  return (data ?? []).length > 0
}

type PaidCheckUser = {
  id: string
  product_id?: string
  app_metadata?: { product_id?: string }
}

// Paid if EITHER signal says so: a live subscription row for this product, or
// the legacy app_metadata.product_id marker. A union rather than a replacement,
// so this change can never newly gate a customer who is already paying.
async function isPaidForProduct(user: PaidCheckUser): Promise<boolean> {
  if (user.product_id === PRODUCT_ID || user.app_metadata?.product_id === PRODUCT_ID) {
    return true
  }
  return hasActiveSubscription(user.id)
}

export function useSubscription() {
  const user = useAuthStore((state) => state.auth.user)
  return useQuery({
    queryKey: ['subscription', PRODUCT_ID, user?.id],
    queryFn: async () => (user ? await hasActiveSubscription(user.id) : false),
    enabled: !!user,
    staleTime: 60_000,
  })
}

export function useTrialUsage() {
  const user = useAuthStore((state) => state.auth.user)
  const { data: subIsPaid, isSuccess } = useSubscription()
  const { data: jobs } = useJobs()
  const used = jobs?.filter(j => ['pending','processing','completed'].includes(j.status)).length ?? 0
  const metaIsPaid =
    (user as PaidCheckUser | null)?.product_id === PRODUCT_ID ||
    (user as PaidCheckUser | null)?.app_metadata?.product_id === PRODUCT_ID
  // While the subscription query is in flight fall back to the metadata marker,
  // so a paid user is never briefly shown the upgrade prompt.
  const isPaid = isSuccess ? !!subIsPaid || !!metaIsPaid : !!metaIsPaid
  return { used, limit: TRIAL_LIMIT, isPaid }
}

async function getRecordCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('jobs')
    .select('*', { count: 'exact', head: true })
    .eq('product_id', PRODUCT_ID)
    .eq('customer_id', userId)
    .in('status', ['pending', 'processing', 'completed'])
  if (error) throw error
  return count ?? 0
}

export function useUploadJob() {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trialLimitReached, setTrialLimitReached] = useState(false)
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.auth.user)

  async function uploadOne(path: string, file: File) {
    const { error: uploadError } = await supabase.storage
      .from('uploads')
      .upload(path, file)
    if (uploadError) throw uploadError
  }

  async function uploadFile(file: File, jobType = 'process_upload') {
    if (!user) { setError('Not logged in'); return null }
    if (!(await isPaidForProduct(user as PaidCheckUser))) {
      const count = await getRecordCount(user.id)
      if (count >= TRIAL_LIMIT) { setTrialLimitReached(true); return null }
    }
    setUploading(true)
    setError(null)
    try {
      const path = `${user.id}/${Date.now()}_${file.name}`
      await uploadOne(path, file)
      const { data: jobData, error: insertError } = await supabase
        .from('jobs')
        .insert({ product_id: PRODUCT_ID, customer_id: user.id, job_type: jobType, status: 'pending', input_file_path: path })
        .select()
        .single()
      if (insertError) throw insertError
      queryClient.invalidateQueries({ queryKey: ['jobs', PRODUCT_ID] })
      if (user?.id && jobData?.id) void writeAudit('job.created', 'job', String(jobData.id), user.id)
      return jobData
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
      return null
    } finally {
      setUploading(false)
    }
  }

  async function uploadFiles(files: File[], jobType = 'process_upload') {
    if (!user) { setError('Not logged in'); return null }
    if (files.length === 0) { setError('No files selected'); return null }
    if (!(await isPaidForProduct(user as PaidCheckUser))) {
      const count = await getRecordCount(user.id)
      if (count >= TRIAL_LIMIT) { setTrialLimitReached(true); return null }
    }
    setUploading(true)
    setError(null)
    try {
      const batchId = Date.now()
      const paths = await Promise.all(
        files.map(async (file) => {
          const path = `${user.id}/${batchId}/${file.name}`
          await uploadOne(path, file)
          return path
        })
      )
      const { data: jobData, error: insertError } = await supabase
        .from('jobs')
        .insert({ product_id: PRODUCT_ID, customer_id: user.id, job_type: jobType, status: 'pending', input_file_paths: paths })
        .select()
        .single()
      if (insertError) throw insertError
      queryClient.invalidateQueries({ queryKey: ['jobs', PRODUCT_ID] })
      return jobData
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
      return null
    } finally {
      setUploading(false)
    }
  }

  return { uploadFile, uploadFiles, uploading, error, trialLimitReached, setTrialLimitReached }
}

// jobs.output_file_path is stored with its bucket prefix ("results/<key>") because
// the poller returns it that way. The storage API wants the key relative to the
// bucket, so passing the stored value straight through requested
// "results/results/<key>" and every download 404'd.
export function resultObjectKey(outputFilePath: string): string {
  return outputFilePath.replace(/^results\//, '')
}

export async function downloadJobResult(outputFilePath: string, filename: string) {
  const { data, error } = await supabase.storage
    .from('results')
    .download(resultObjectKey(outputFilePath))
  if (error) throw error
  const url = URL.createObjectURL(data)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
