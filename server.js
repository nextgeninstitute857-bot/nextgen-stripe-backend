import React, { useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Bot,
  CalendarCheck,
  CheckCircle2,
  ClipboardList,
  Copy,
  Eye,
  Facebook,
  Filter,
  Globe2,
  Handshake,
  Hash,
  Instagram,
  Linkedin,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  UserPlus,
  Users,
  Youtube,
  Twitter,
} from 'lucide-react';
import { crmFetch } from '@/lib/crmApiClient.js';
import { toast } from 'sonner';

const PLATFORM_META = {
  reddit: { label: 'Reddit', icon: MessageSquare, badge: 'bg-orange-100 text-orange-800 border-orange-200' },
  telegram: { label: 'Telegram', icon: Send, badge: 'bg-sky-100 text-sky-800 border-sky-200' },
  facebook: { label: 'Facebook', icon: Facebook, badge: 'bg-blue-100 text-blue-800 border-blue-200' },
  instagram: { label: 'Instagram', icon: Instagram, badge: 'bg-pink-100 text-pink-800 border-pink-200' },
  youtube: { label: 'YouTube', icon: Youtube, badge: 'bg-red-100 text-red-800 border-red-200' },
  linkedin: { label: 'LinkedIn', icon: Linkedin, badge: 'bg-cyan-100 text-cyan-800 border-cyan-200' },
  twitter: { label: 'X / Twitter', icon: Twitter, badge: 'bg-slate-100 text-slate-800 border-slate-200' },
  discord: { label: 'Discord', icon: Hash, badge: 'bg-indigo-100 text-indigo-800 border-indigo-200' },
  other: { label: 'Other', icon: Globe2, badge: 'bg-slate-100 text-slate-700 border-slate-200' },
};

const DEFAULT_TASK_FORM = {
  name: '',
  platform: 'reddit',
  community_name: '',
  community_url: '',
  keywords: 'USMLE, Step 1, NBME, UWorld, First Aid, exam date, failed, low score',
  status: 'active',
  frequency: 'daily',
  approval_required: true,
  outreach_style: 'friendly_helpful_no_pitch',
  notes: '',
};

const DEFAULT_OPPORTUNITY_FORM = {
  platform: 'reddit',
  community_name: '',
  post_url: '',
  author_name: '',
  title: '',
  detected_text: '',
  intent: 'exam_difficulty',
  priority: 'medium',
  status: 'new',
  suggested_reply: '',
};

const DEFAULT_QUALIFICATION = {
  exam_type: 'Step 1',
  exam_date: '',
  exam_timeline: '',
  nbme_score: '',
  uworld_progress: '',
  current_resources: '',
  difficulty: '',
  pain_points: '',
  study_hours: '',
  budget_level: '',
  interest_level: 'medium',
  preferred_contact_method: '',
  recommended_offer: 'Free live/demo session',
  notes: '',
};

const TASK_ENDPOINTS = ['/admin/crm/community-intelligence/tasks', '/admin/crm/community-intelligence-tasks', '/admin/crm/community-tasks'];
const OPPORTUNITY_ENDPOINTS = ['/admin/crm/community-intelligence/opportunities', '/admin/crm/community-opportunities', '/admin/crm/community-intelligence-opportunities'];
const DRAFT_ENDPOINTS = ['/admin/crm/community-intelligence/reply-drafts', '/admin/crm/community-reply-drafts', '/admin/crm/approval-queue?type=community_reply', '/admin/crm/approval-queue'];

const getArray = (data, keys = []) => {
  if (Array.isArray(data)) return data;
  for (const key of keys) if (Array.isArray(data?.[key])) return data[key];
  return [];
};

const fetchFirst = async (endpoints, options = {}) => {
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const data = await crmFetch(endpoint, options);
      return { data, endpoint };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No endpoint available');
};

const normalizePlatform = (value) => {
  const clean = String(value || 'other').toLowerCase().trim();
  if (clean === 'x') return 'twitter';
  return PLATFORM_META[clean] ? clean : 'other';
};

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
};

const platformBadge = (platformValue) => {
  const platform = normalizePlatform(platformValue);
  const meta = PLATFORM_META[platform] || PLATFORM_META.other;
  const Icon = meta.icon;
  return <Badge variant="outline" className={`gap-1.5 font-bold ${meta.badge}`}><Icon className="w-3.5 h-3.5" />{meta.label}</Badge>;
};

const statusBadge = (statusValue) => {
  const status = String(statusValue || 'new').toLowerCase();
  if (['active', 'approved', 'sent', 'converted', 'captured', 'lead_created', 'qualified', 'handoff_to_sales', 'sent_to_live_conversion'].includes(status)) {
    return <Badge className="bg-[#10B981] hover:bg-[#059669] capitalize">{status.replaceAll('_', ' ')}</Badge>;
  }
  if (['paused', 'pending', 'needs_approval', 'draft', 'new', 'soft_outreach_drafted'].includes(status)) {
    return <Badge className="bg-amber-500 hover:bg-amber-600 capitalize">{status.replaceAll('_', ' ')}</Badge>;
  }
  if (['rejected', 'error', 'blocked', 'unsafe', 'ignored'].includes(status)) {
    return <Badge variant="destructive" className="capitalize">{status.replaceAll('_', ' ')}</Badge>;
  }
  return <Badge variant="secondary" className="capitalize">{status.replaceAll('_', ' ')}</Badge>;
};

const priorityBadge = (priorityValue) => {
  const priority = String(priorityValue || 'medium').toLowerCase();
  if (priority === 'high' || priority === 'hot') return <Badge className="bg-red-500 hover:bg-red-600">High</Badge>;
  if (priority === 'low') return <Badge variant="outline">Low</Badge>;
  return <Badge className="bg-[#2563EB] hover:bg-[#1D4ED8]">Medium</Badge>;
};

const getOpportunityText = (item) => item?.detected_text || item?.source_text || item?.summary || item?.post_text || item?.message || '';
const getOpportunityTitle = (item) => item?.title || item?.community_name || item?.author_name || 'Community opportunity';
const getLeadId = (item) => item?.lead_id || item?.lead?.id || item?.converted_lead_id || '';

const CommunityIntelligencePage = () => {
  const [tasks, setTasks] = useState([]);
  const [opportunities, setOpportunities] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [communities, setCommunities] = useState([]);
  const [agents, setAgents] = useState([]);
  const [teamMembers, setTeamMembers] = useState([]);
  const [liveSessions, setLiveSessions] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [opportunityDialogOpen, setOpportunityDialogOpen] = useState(false);
  const [draftDialogOpen, setDraftDialogOpen] = useState(false);
  const [qualificationDialogOpen, setQualificationDialogOpen] = useState(false);
  const [selectedDraft, setSelectedDraft] = useState(null);
  const [selectedOpportunity, setSelectedOpportunity] = useState(null);
  const [taskForm, setTaskForm] = useState(DEFAULT_TASK_FORM);
  const [opportunityForm, setOpportunityForm] = useState(DEFAULT_OPPORTUNITY_FORM);
  const [qualificationForm, setQualificationForm] = useState(DEFAULT_QUALIFICATION);
  const [filters, setFilters] = useState({ platform: 'all', status: 'all', q: '' });

  const loadData = async () => {
    setLoading(true);
    try {
      const [taskResult, opportunityResult, draftResult, communityResult, agentResult, teamResult, sessionResult, planResult] = await Promise.allSettled([
        fetchFirst(TASK_ENDPOINTS),
        fetchFirst(OPPORTUNITY_ENDPOINTS),
        fetchFirst(DRAFT_ENDPOINTS),
        crmFetch('/admin/crm/communities'),
        crmFetch('/admin/crm/agents'),
        crmFetch('/admin/crm/team-members'),
        crmFetch('/admin/live-sessions'),
        crmFetch('/admin/plans'),
      ]);

      setTasks(taskResult.status === 'fulfilled' ? getArray(taskResult.value.data, ['tasks', 'community_intelligence_tasks', 'items', 'records']) : []);
      setOpportunities(opportunityResult.status === 'fulfilled' ? getArray(opportunityResult.value.data, ['opportunities', 'community_opportunities', 'items', 'records']) : []);
      setDrafts(draftResult.status === 'fulfilled' ? getArray(draftResult.value.data, ['drafts', 'reply_drafts', 'items', 'approval_queue', 'records']) : []);
      setCommunities(communityResult.status === 'fulfilled' ? getArray(communityResult.value, ['communities', 'items', 'records']) : []);
      setAgents(agentResult.status === 'fulfilled' ? getArray(agentResult.value, ['agents', 'items', 'records']) : []);
      setTeamMembers(teamResult.status === 'fulfilled' ? getArray(teamResult.value, ['members', 'team_members', 'items', 'records']) : []);
      setLiveSessions(sessionResult.status === 'fulfilled' ? getArray(sessionResult.value, ['sessions', 'liveSessions', 'items', 'records']) : []);
      setPlans(planResult.status === 'fulfilled' ? getArray(planResult.value, ['plans', 'items', 'records']) : []);
    } catch (error) {
      toast.error(error.message || 'Failed to load community intelligence');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const filteredOpportunities = useMemo(() => {
    return opportunities.filter((item) => {
      const platform = normalizePlatform(item.platform || item.source_platform);
      const status = String(item.status || 'new').toLowerCase();
      const haystack = JSON.stringify(item).toLowerCase();
      if (filters.platform !== 'all' && platform !== filters.platform) return false;
      if (filters.status !== 'all' && status !== filters.status) return false;
      if (filters.q && !haystack.includes(filters.q.toLowerCase())) return false;
      return true;
    });
  }, [opportunities, filters]);

  const stats = useMemo(() => {
    const open = opportunities.filter((item) => ['new', 'open', 'pending'].includes(String(item.status || 'new').toLowerCase())).length;
    const outreach = opportunities.filter((item) => ['soft_outreach_drafted', 'drafted'].includes(String(item.status || '').toLowerCase())).length;
    const qualified = opportunities.filter((item) => ['qualified', 'lead_created', 'handoff_to_sales', 'sent_to_live_conversion'].includes(String(item.status || '').toLowerCase())).length;
    const handoffs = opportunities.filter((item) => String(item.status || '').toLowerCase() === 'handoff_to_sales').length;
    return { open, outreach, qualified, handoffs, tasks: tasks.length, drafts: drafts.length };
  }, [tasks, opportunities, drafts]);

  const saveTask = async () => {
    if (!taskForm.name && !taskForm.community_name) return toast.error('Add a task/community name');
    setSaving(true);
    try {
      await fetchFirst(TASK_ENDPOINTS, { method: 'POST', body: JSON.stringify({ ...taskForm, keywords: String(taskForm.keywords || '').split(',').map((x) => x.trim()).filter(Boolean) }) });
      toast.success('Watch task saved');
      setTaskDialogOpen(false);
      setTaskForm(DEFAULT_TASK_FORM);
      loadData();
    } catch (error) { toast.error(error.message || 'Failed to save task'); }
    finally { setSaving(false); }
  };

  const saveOpportunity = async () => {
    if (!opportunityForm.title && !opportunityForm.detected_text) return toast.error('Add a title or detected text');
    setSaving(true);
    try {
      await fetchFirst(OPPORTUNITY_ENDPOINTS, { method: 'POST', body: JSON.stringify(opportunityForm) });
      toast.success('Opportunity saved');
      setOpportunityDialogOpen(false);
      setOpportunityForm(DEFAULT_OPPORTUNITY_FORM);
      loadData();
    } catch (error) { toast.error(error.message || 'Failed to save opportunity'); }
    finally { setSaving(false); }
  };

  const deleteTask = async (task) => {
    if (!task?.id) return toast.error('Task ID missing');
    if (!window.confirm('Delete this watch task?')) return;
    try {
      await fetchFirst(TASK_ENDPOINTS.map((endpoint) => `${endpoint}/${task.id}`), { method: 'DELETE' });
      toast.success('Task deleted');
      loadData();
    } catch (error) { toast.error(error.message || 'Failed to delete task'); }
  };

  const createLeadFromOpportunity = async (opportunity) => {
    if (!opportunity?.id) return toast.error('Opportunity ID missing');
    try {
      const data = await crmFetch(`/admin/crm/community-intelligence/opportunities/${opportunity.id}/create-lead`, {
        method: 'POST',
        body: JSON.stringify({
          platform: opportunity.platform || 'other',
          message: getOpportunityText(opportunity),
          name: opportunity.author_name || opportunity.name || '',
          status: 'community_lead',
        }),
      });
      toast.success(data?.created ? 'Lead created from opportunity' : 'Lead connected to opportunity');
      loadData();
      return data?.lead;
    } catch (error) { toast.error(error.message || 'Could not create lead'); return null; }
  };

  const generateSoftOutreachDraft = async (opportunity) => {
    if (!opportunity?.id) return toast.error('Opportunity ID missing');
    setGenerating(true);
    try {
      let data;
      try {
        data = await crmFetch(`/admin/crm/community-intelligence/opportunities/${opportunity.id}/soft-outreach-draft`, {
          method: 'POST',
          body: JSON.stringify({ style: 'friendly_helpful_no_pitch' }),
        });
      } catch {
        data = await crmFetch('/admin/crm/ai/generate-post', {
          method: 'POST',
          body: JSON.stringify({
            platform: opportunity.platform || 'reddit',
            post_type: 'helpful_reply',
            topic: getOpportunityText(opportunity),
            audience: 'USMLE students',
            cta: 'Ask one helpful question. Do not pitch directly.',
            language: 'english',
          }),
        });
      }

      const content = data?.draft?.draft_content || data?.draft_content || data?.post?.content || data?.content || data?.reply || '';
      const draft = {
        id: data?.draft?.id || data?.approval_item?.id || data?.ai_action?.id || `local-${Date.now()}`,
        platform: opportunity.platform || 'other',
        status: 'draft',
        action_type: 'community_soft_outreach_draft',
        draft_content: content,
        message: content,
        opportunity_id: opportunity.id,
        created_at: new Date().toISOString(),
      };
      setSelectedDraft(draft);
      setDraftDialogOpen(true);
      toast.success('Soft outreach draft ready for review');
      loadData();
    } catch (error) { toast.error(error.message || 'Failed to generate soft outreach draft'); }
    finally { setGenerating(false); }
  };

  const openQualification = (opportunity) => {
    setSelectedOpportunity(opportunity);
    setQualificationForm({
      ...DEFAULT_QUALIFICATION,
      exam_type: opportunity.exam_type || opportunity.detected_exam || DEFAULT_QUALIFICATION.exam_type,
      exam_date: opportunity.exam_date || '',
      exam_timeline: opportunity.exam_timeline || '',
      difficulty: opportunity.difficulty || opportunity.pain_points || '',
      pain_points: opportunity.pain_points || getOpportunityText(opportunity),
      interest_level: opportunity.interest_level || 'medium',
      recommended_offer: opportunity.recommended_offer || 'Free live/demo session',
    });
    setQualificationDialogOpen(true);
  };

  const qualifyOpportunity = async () => {
    if (!selectedOpportunity?.id) return toast.error('Opportunity missing');
    setSaving(true);
    try {
      await crmFetch(`/admin/crm/community-intelligence/opportunities/${selectedOpportunity.id}/qualify`, {
        method: 'POST',
        body: JSON.stringify({ ...qualificationForm, create_lead: true }),
      });
      toast.success('Opportunity qualified and lead data saved');
      setQualificationDialogOpen(false);
      loadData();
    } catch (error) { toast.error(error.message || 'Could not qualify opportunity'); }
    finally { setSaving(false); }
  };

  const assignOpportunity = async (opportunity, type = 'community') => {
    if (!opportunity?.id) return toast.error('Opportunity missing');
    const pool = [...agents, ...teamMembers];
    const member = pool.find((item) => {
      const role = String(item.agent_type || item.role_name || item.role || '').toLowerCase();
      if (type === 'sales') return role.includes('sales') || role.includes('closer');
      return role.includes('community') || role.includes('agent') || role.includes('follow');
    }) || pool[0];
    if (!member?.id) return toast.error('Create an agent/team member first');
    try {
      await crmFetch(`/admin/crm/community-intelligence/opportunities/${opportunity.id}/assign-agent`, {
        method: 'POST',
        body: JSON.stringify({ agent_type: type, agent_id: member.id, agent_name: member.name || member.agent_name || member.email }),
      });
      toast.success(type === 'sales' ? 'Assigned to sales agent' : 'Assigned to community agent');
      loadData();
    } catch (error) { toast.error(error.message || 'Could not assign agent'); }
  };

  const handoffToSales = async (opportunity) => {
    if (!opportunity?.id) return toast.error('Opportunity missing');
    try {
      await crmFetch(`/admin/crm/community-intelligence/opportunities/${opportunity.id}/handoff`, {
        method: 'POST',
        body: JSON.stringify({
          handoff_summary: `Community lead from ${opportunity.platform || 'community'}: ${getOpportunityText(opportunity).slice(0, 500)}`,
          recommended_next_action: 'Sales agent should invite to demo/live session, then recommend the best plan.',
          lead_status: 'hot_lead',
        }),
      });
      toast.success('Opportunity handed off to sales');
      loadData();
    } catch (error) { toast.error(error.message || 'Could not handoff to sales'); }
  };

  const sendToLiveConversion = async (opportunity) => {
    if (!opportunity?.id) return toast.error('Opportunity missing');
    const session = liveSessions.find((item) => String(item.status || 'scheduled') !== 'completed') || liveSessions[0];
    const plan = plans[0];
    try {
      await crmFetch(`/admin/crm/community-intelligence/opportunities/${opportunity.id}/send-to-live-conversion`, {
        method: 'POST',
        body: JSON.stringify({
          session_id: session?.id || null,
          session_title: session?.topic || session?.title || '',
          plan_id: plan?.id || null,
          plan_name: plan?.name || '',
          invite_status: 'draft_needs_approval',
        }),
      });
      toast.success('Moved to live/demo conversion flow');
      loadData();
    } catch (error) { toast.error(error.message || 'Could not move to live conversion'); }
  };

  const approveDraft = async (draft, status = 'approved') => {
    if (!draft?.id) return toast.error('Draft ID missing');
    try {
      await crmFetch(`/admin/crm/approval-queue/${draft.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status, review_note: status === 'approved' ? 'Approved from Community Intelligence' : 'Rejected from Community Intelligence' }),
      });
      toast.success(status === 'approved' ? 'Draft approved' : 'Draft rejected');
      setDraftDialogOpen(false);
      loadData();
    } catch (error) { toast.error(error.message || 'Could not update approval status'); }
  };

  const copyText = async (text) => {
    await navigator.clipboard.writeText(String(text || ''));
    toast.success('Copied');
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <Helmet><title>Community Lead Pipeline - CRM Growth Engine</title></Helmet>

      <Card className="border-[#DDF3EA] rounded-[30px] shadow-[0_18px_60px_rgba(16,185,129,0.08)]">
        <CardHeader>
          <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-5">
            <div className="flex items-start gap-4">
              <div className="w-14 h-14 rounded-2xl bg-[#ECFDF5] flex items-center justify-center shrink-0"><Eye className="w-7 h-7 text-[#10B981]" /></div>
              <div>
                <CardTitle className="text-3xl font-serif text-[#060F1E]">Community Lead Pipeline</CardTitle>
                <CardDescription className="text-base font-semibold mt-2 text-[#5A7A9A] max-w-4xl">
                  Watch communities, detect potential USMLE students, draft soft helpful outreach, qualify exam details, assign a community agent, then hand off warm leads to sales or live/demo conversion.
                </CardDescription>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={loadData} className="gap-2"><RefreshCw className="w-4 h-4" /> Refresh</Button>
              <Button variant="outline" onClick={() => setTaskDialogOpen(true)} className="gap-2"><Plus className="w-4 h-4" /> Watch Task</Button>
              <Button onClick={() => setOpportunityDialogOpen(true)} className="gap-2 bg-[#10B981] hover:bg-[#059669]"><Plus className="w-4 h-4" /> Add Opportunity</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-3xl border border-amber-200 bg-amber-50 p-5 flex gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-700 mt-1 shrink-0" />
            <div>
              <p className="font-black text-amber-900">Approval-first, no spam automation.</p>
              <p className="text-sm font-semibold text-amber-800 mt-1 leading-6">The system should discover opportunities and draft friendly replies. A human/community agent approves the outreach and collects exam details before sales pitch or payment link.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-4">
        {[
          ['Open Opportunities', stats.open, Target],
          ['Soft Outreach', stats.outreach, MessageSquare],
          ['Qualified', stats.qualified, BadgeCheck],
          ['Sales Handoffs', stats.handoffs, Handshake],
          ['Watch Tasks', stats.tasks, Eye],
          ['Pending Drafts', stats.drafts, ClipboardList],
        ].map(([label, value, Icon]) => (
          <Card key={label} className="border-[#DDF3EA] rounded-2xl"><CardContent className="p-4"><Icon className="w-5 h-5 text-[#10B981] mb-3" /><p className="text-2xl font-black text-[#060F1E]">{value}</p><p className="text-xs font-bold text-[#5A7A9A] mt-1">{label}</p></CardContent></Card>
        ))}
      </div>

      <Card className="border-[#DDF3EA] rounded-[26px]">
        <CardHeader>
          <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
            <div><CardTitle>Detected Opportunities</CardTitle><CardDescription>Soft outreach → qualification → community agent → sales handoff → live session.</CardDescription></div>
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative"><Search className="w-4 h-4 absolute left-3 top-3 text-[#5A7A9A]" /><Input className="pl-9 w-full sm:w-[260px]" placeholder="Search opportunities..." value={filters.q} onChange={(e) => setFilters((prev) => ({ ...prev, q: e.target.value }))} /></div>
              <Select value={filters.platform} onValueChange={(value) => setFilters((prev) => ({ ...prev, platform: value }))}><SelectTrigger className="w-full sm:w-[170px]"><Filter className="w-4 h-4 mr-2" /><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All platforms</SelectItem>{Object.entries(PLATFORM_META).map(([key, meta]) => <SelectItem key={key} value={key}>{meta.label}</SelectItem>)}</SelectContent></Select>
              <Select value={filters.status} onValueChange={(value) => setFilters((prev) => ({ ...prev, status: value }))}><SelectTrigger className="w-full sm:w-[190px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All statuses</SelectItem><SelectItem value="new">New</SelectItem><SelectItem value="soft_outreach_drafted">Soft outreach drafted</SelectItem><SelectItem value="lead_created">Lead created</SelectItem><SelectItem value="qualified">Qualified</SelectItem><SelectItem value="handoff_to_sales">Handoff to sales</SelectItem><SelectItem value="sent_to_live_conversion">Live conversion</SelectItem></SelectContent></Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? <Skeleton className="h-96 rounded-3xl" /> : filteredOpportunities.length === 0 ? (
            <div className="rounded-3xl border border-dashed p-10 text-center"><Target className="w-10 h-10 mx-auto text-[#10B981] mb-4" /><p className="font-black text-[#060F1E]">No opportunities yet</p><p className="text-sm text-[#5A7A9A] mt-2">Add one manually or create watch tasks for Reddit, Telegram, YouTube comments, and other channels.</p></div>
          ) : (
            <div className="space-y-4">
              {filteredOpportunities.map((item, index) => {
                const leadId = getLeadId(item);
                return (
                  <div key={item.id || index} className="rounded-3xl border border-[#DDF3EA] bg-white p-5 shadow-sm">
                    <div className="flex flex-col 2xl:flex-row 2xl:items-start 2xl:justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 mb-3">{platformBadge(item.platform || item.source_platform)}{priorityBadge(item.priority || item.lead_priority)}{statusBadge(item.status || 'new')}{leadId && <Badge variant="outline" className="bg-[#ECFDF5] text-[#047857] border-[#A7F3D0]">Lead connected</Badge>}</div>
                        <p className="font-black text-lg text-[#060F1E]">{getOpportunityTitle(item)}</p>
                        <p className="text-sm font-semibold text-[#5A7A9A] mt-2 leading-6 line-clamp-3">{getOpportunityText(item) || 'No detected text available.'}</p>
                        <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-xs font-bold text-[#5A7A9A]">
                          <span>Intent: {String(item.intent || item.detected_intent || 'unknown').replaceAll('_', ' ')}</span>
                          <span>Author: {item.author_name || item.username || '—'}</span>
                          <span>Detected: {formatDate(item.created_at || item.detected_at || item.updated_at)}</span>
                          {item.post_url && <a className="text-[#2563EB]" href={item.post_url} target="_blank" rel="noreferrer">Open source</a>}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-2 gap-2 min-w-[340px]">
                        <Button size="sm" variant="outline" onClick={() => generateSoftOutreachDraft(item)} disabled={generating} className="gap-2"><Sparkles className="w-4 h-4" /> Soft Reply</Button>
                        <Button size="sm" variant="outline" onClick={() => createLeadFromOpportunity(item)} className="gap-2"><UserPlus className="w-4 h-4" /> Create Lead</Button>
                        <Button size="sm" variant="outline" onClick={() => openQualification(item)} className="gap-2"><ClipboardList className="w-4 h-4" /> Qualify</Button>
                        <Button size="sm" variant="outline" onClick={() => assignOpportunity(item, 'community')} className="gap-2"><Users className="w-4 h-4" /> Community Agent</Button>
                        <Button size="sm" variant="outline" onClick={() => handoffToSales(item)} className="gap-2"><Handshake className="w-4 h-4" /> Sales Handoff</Button>
                        <Button size="sm" onClick={() => sendToLiveConversion(item)} className="gap-2 bg-[#10B981] hover:bg-[#059669]"><CalendarCheck className="w-4 h-4" /> Live Session</Button>
                        <Button size="sm" variant="ghost" onClick={() => copyText(getOpportunityText(item))} className="gap-2 col-span-2 md:col-span-3 2xl:col-span-2"><Copy className="w-4 h-4" /> Copy source text</Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card className="border-[#DDF3EA] rounded-[26px]">
          <CardHeader><CardTitle className="flex items-center gap-2"><Eye className="w-5 h-5 text-[#2563EB]" /> Watch Tasks</CardTitle><CardDescription>Communities and keywords your team monitors.</CardDescription></CardHeader>
          <CardContent>{loading ? <Skeleton className="h-40 rounded-2xl" /> : tasks.length === 0 ? <p className="text-sm text-[#5A7A9A]">No watch tasks yet.</p> : <div className="space-y-3 max-h-[420px] overflow-y-auto pr-2">{tasks.map((task) => <div key={task.id} className="rounded-2xl border p-4 bg-white"><div className="flex items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2 mb-2">{platformBadge(task.platform)}{statusBadge(task.status || 'active')}</div><p className="font-black text-[#060F1E]">{task.name || task.community_name || 'Watch task'}</p><p className="text-sm text-[#5A7A9A] mt-1">{task.community_name || task.community_url || 'Community not set'}</p><p className="text-xs text-[#5A7A9A] mt-2">Keywords: {Array.isArray(task.keywords) ? task.keywords.join(', ') : task.keywords || '—'}</p></div><Button size="icon" variant="ghost" className="text-destructive" onClick={() => deleteTask(task)}><Trash2 className="w-4 h-4" /></Button></div></div>)}</div>}</CardContent>
        </Card>

        <Card className="border-[#DDF3EA] rounded-[26px]">
          <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-[#10B981]" /> Approval Queue Drafts</CardTitle><CardDescription>Helpful replies should be approved before posting or sending.</CardDescription></CardHeader>
          <CardContent>{loading ? <Skeleton className="h-40 rounded-2xl" /> : drafts.length === 0 ? <p className="text-sm text-[#5A7A9A]">No pending community reply drafts.</p> : <div className="space-y-3 max-h-[420px] overflow-y-auto pr-2">{drafts.slice(0, 10).map((draft, index) => <div key={draft.id || index} className="rounded-2xl border p-4 bg-white"><div className="flex items-start justify-between gap-3"><div className="space-y-2">{platformBadge(draft.platform || draft.channel || draft.source_platform)} {statusBadge(draft.status || draft.approval_status || 'pending')}<p className="text-sm text-[#5A7A9A] line-clamp-3">{draft.draft_content || draft.output_text || draft.message || draft.content || 'No draft content'}</p></div><Button size="sm" variant="outline" onClick={() => { setSelectedDraft(draft); setDraftDialogOpen(true); }}>Review</Button></div></div>)}</div>}</CardContent>
        </Card>
      </div>

      <Card className="border-[#DDF3EA] rounded-[26px]">
        <CardHeader><CardTitle className="flex items-center gap-2"><ArrowRight className="w-5 h-5 text-[#2563EB]" /> Pipeline Rule</CardTitle><CardDescription>The correct order for community leads.</CardDescription></CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            {['Detect opportunity', 'Soft helpful outreach', 'Collect exam details', 'Assign/handoff', 'Live demo or plan'].map((step, index) => <div key={step} className="rounded-2xl border bg-[#F8FBFF] p-4"><p className="text-xs font-black text-[#10B981]">STEP {index + 1}</p><p className="font-black text-[#060F1E] mt-2">{step}</p></div>)}
          </div>
        </CardContent>
      </Card>

      <Dialog open={taskDialogOpen} onOpenChange={setTaskDialogOpen}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Create Watch Task</DialogTitle><DialogDescription>Tell the CRM which community or keyword cluster to monitor.</DialogDescription></DialogHeader><div className="grid grid-cols-1 md:grid-cols-2 gap-4"><div className="space-y-2"><label className="text-sm font-bold">Task name</label><Input value={taskForm.name} onChange={(e) => setTaskForm({ ...taskForm, name: e.target.value })} placeholder="Reddit NBME low score watch" /></div><div className="space-y-2"><label className="text-sm font-bold">Platform</label><Select value={taskForm.platform} onValueChange={(value) => setTaskForm({ ...taskForm, platform: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(PLATFORM_META).map(([key, meta]) => <SelectItem key={key} value={key}>{meta.label}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><label className="text-sm font-bold">Community name</label><Input value={taskForm.community_name} onChange={(e) => setTaskForm({ ...taskForm, community_name: e.target.value })} /></div><div className="space-y-2"><label className="text-sm font-bold">Community URL</label><Input value={taskForm.community_url} onChange={(e) => setTaskForm({ ...taskForm, community_url: e.target.value })} /></div><div className="md:col-span-2 space-y-2"><label className="text-sm font-bold">Keywords</label><Textarea value={taskForm.keywords} onChange={(e) => setTaskForm({ ...taskForm, keywords: e.target.value })} /></div><div className="md:col-span-2 flex items-center justify-between rounded-2xl border p-4"><div><p className="font-bold">Require approval before outreach</p><p className="text-xs text-[#5A7A9A]">Recommended for Reddit, Facebook, Instagram, YouTube and Telegram groups.</p></div><Switch checked={taskForm.approval_required} onCheckedChange={(checked) => setTaskForm({ ...taskForm, approval_required: checked })} /></div></div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setTaskDialogOpen(false)}>Cancel</Button><Button onClick={saveTask} disabled={saving}>{saving ? 'Saving...' : 'Save Task'}</Button></div></DialogContent></Dialog>

      <Dialog open={opportunityDialogOpen} onOpenChange={setOpportunityDialogOpen}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Add Community Opportunity</DialogTitle><DialogDescription>Manually add a post/comment/message from a community.</DialogDescription></DialogHeader><div className="grid grid-cols-1 md:grid-cols-2 gap-4"><div className="space-y-2"><label className="text-sm font-bold">Platform</label><Select value={opportunityForm.platform} onValueChange={(value) => setOpportunityForm({ ...opportunityForm, platform: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(PLATFORM_META).map(([key, meta]) => <SelectItem key={key} value={key}>{meta.label}</SelectItem>)}</SelectContent></Select></div><div className="space-y-2"><label className="text-sm font-bold">Community</label><Input value={opportunityForm.community_name} onChange={(e) => setOpportunityForm({ ...opportunityForm, community_name: e.target.value })} /></div><div className="space-y-2"><label className="text-sm font-bold">Author / Username</label><Input value={opportunityForm.author_name} onChange={(e) => setOpportunityForm({ ...opportunityForm, author_name: e.target.value })} /></div><div className="space-y-2"><label className="text-sm font-bold">Post URL</label><Input value={opportunityForm.post_url} onChange={(e) => setOpportunityForm({ ...opportunityForm, post_url: e.target.value })} /></div><div className="md:col-span-2 space-y-2"><label className="text-sm font-bold">Title</label><Input value={opportunityForm.title} onChange={(e) => setOpportunityForm({ ...opportunityForm, title: e.target.value })} /></div><div className="md:col-span-2 space-y-2"><label className="text-sm font-bold">Detected text</label><Textarea className="min-h-[120px]" value={opportunityForm.detected_text} onChange={(e) => setOpportunityForm({ ...opportunityForm, detected_text: e.target.value })} /></div><div className="space-y-2"><label className="text-sm font-bold">Intent</label><Select value={opportunityForm.intent} onValueChange={(value) => setOpportunityForm({ ...opportunityForm, intent: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="exam_difficulty">Exam difficulty</SelectItem><SelectItem value="course_inquiry">Course inquiry</SelectItem><SelectItem value="nbme_low_score">NBME low score</SelectItem><SelectItem value="uworld_help">UWorld help</SelectItem><SelectItem value="study_partner">Study partner</SelectItem></SelectContent></Select></div><div className="space-y-2"><label className="text-sm font-bold">Priority</label><Select value={opportunityForm.priority} onValueChange={(value) => setOpportunityForm({ ...opportunityForm, priority: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem></SelectContent></Select></div></div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setOpportunityDialogOpen(false)}>Cancel</Button><Button onClick={saveOpportunity} disabled={saving}>{saving ? 'Saving...' : 'Save Opportunity'}</Button></div></DialogContent></Dialog>

      <Dialog open={qualificationDialogOpen} onOpenChange={setQualificationDialogOpen}><DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>Qualify Community Lead</DialogTitle><DialogDescription>Collect exam date, resources, difficulties, and interest before handing to sales.</DialogDescription></DialogHeader><div className="grid grid-cols-1 md:grid-cols-2 gap-4"><div className="space-y-2"><label className="text-sm font-bold">Exam</label><Select value={qualificationForm.exam_type} onValueChange={(value) => setQualificationForm({ ...qualificationForm, exam_type: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Step 1">Step 1</SelectItem><SelectItem value="Step 2 CK">Step 2 CK</SelectItem><SelectItem value="Unknown">Unknown</SelectItem></SelectContent></Select></div><div className="space-y-2"><label className="text-sm font-bold">Exam date</label><Input type="date" value={qualificationForm.exam_date} onChange={(e) => setQualificationForm({ ...qualificationForm, exam_date: e.target.value })} /></div><div className="space-y-2"><label className="text-sm font-bold">Timeline</label><Input value={qualificationForm.exam_timeline} onChange={(e) => setQualificationForm({ ...qualificationForm, exam_timeline: e.target.value })} placeholder="2 months / 8 weeks" /></div><div className="space-y-2"><label className="text-sm font-bold">NBME score</label><Input value={qualificationForm.nbme_score} onChange={(e) => setQualificationForm({ ...qualificationForm, nbme_score: e.target.value })} /></div><div className="space-y-2"><label className="text-sm font-bold">UWorld progress</label><Input value={qualificationForm.uworld_progress} onChange={(e) => setQualificationForm({ ...qualificationForm, uworld_progress: e.target.value })} /></div><div className="space-y-2"><label className="text-sm font-bold">Current resources</label><Input value={qualificationForm.current_resources} onChange={(e) => setQualificationForm({ ...qualificationForm, current_resources: e.target.value })} /></div><div className="md:col-span-2 space-y-2"><label className="text-sm font-bold">Main difficulty / pain points</label><Textarea value={qualificationForm.pain_points} onChange={(e) => setQualificationForm({ ...qualificationForm, pain_points: e.target.value, difficulty: e.target.value })} /></div><div className="space-y-2"><label className="text-sm font-bold">Interest level</label><Select value={qualificationForm.interest_level} onValueChange={(value) => setQualificationForm({ ...qualificationForm, interest_level: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem><SelectItem value="hot">Hot</SelectItem></SelectContent></Select></div><div className="space-y-2"><label className="text-sm font-bold">Recommended offer</label><Input value={qualificationForm.recommended_offer} onChange={(e) => setQualificationForm({ ...qualificationForm, recommended_offer: e.target.value })} /></div><div className="md:col-span-2 space-y-2"><label className="text-sm font-bold">Notes for sales agent</label><Textarea value={qualificationForm.notes} onChange={(e) => setQualificationForm({ ...qualificationForm, notes: e.target.value })} /></div></div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setQualificationDialogOpen(false)}>Cancel</Button><Button onClick={qualifyOpportunity} disabled={saving}>{saving ? 'Saving...' : 'Save Qualification'}</Button></div></DialogContent></Dialog>

      <Dialog open={draftDialogOpen} onOpenChange={setDraftDialogOpen}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Review Soft Outreach Draft</DialogTitle><DialogDescription>Copy or approve only after checking that it is friendly, helpful, and not spammy.</DialogDescription></DialogHeader><div className="rounded-2xl border bg-[#F8FBFF] p-5"><div className="flex flex-wrap gap-2 mb-4">{platformBadge(selectedDraft?.platform || selectedDraft?.channel)}{statusBadge(selectedDraft?.status || selectedDraft?.approval_status || 'draft')}</div><p className="whitespace-pre-wrap text-sm leading-7 text-[#060F1E]">{selectedDraft?.draft_content || selectedDraft?.output_text || selectedDraft?.message || selectedDraft?.content || 'No draft content'}</p></div><div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => copyText(selectedDraft?.draft_content || selectedDraft?.output_text || selectedDraft?.message || selectedDraft?.content || '')} className="gap-2"><Copy className="w-4 h-4" /> Copy</Button><Button variant="outline" onClick={() => approveDraft(selectedDraft, 'rejected')}>Reject</Button><Button onClick={() => approveDraft(selectedDraft, 'approved')} className="gap-2 bg-[#10B981] hover:bg-[#059669]"><CheckCircle2 className="w-4 h-4" /> Approve</Button></div></DialogContent></Dialog>
    </div>
  );
};

export default CommunityIntelligencePage;
