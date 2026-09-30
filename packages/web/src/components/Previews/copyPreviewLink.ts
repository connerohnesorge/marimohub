import { toast } from 'sonner';

export async function copyPreviewLink(url: string): Promise<void> {
	try {
		if (!navigator.clipboard) throw new Error('Clipboard unavailable');
		await navigator.clipboard.writeText(url);
		toast.success('Preview link copied');
	} catch {
		toast.error('Unable to copy the link');
	}
}
