/**
 * Textes du lecteur d'images (FR + DE). Le contrat (PlanDocument.warnings) attend du français : `readImage`
 * produit donc du français ; `readImageDetailed(…, { lang: 'de' })` donne les mêmes textes en allemand.
 */
import type { Lang } from '../../core/types';
import { registerMessages, t, type Dictionary } from '../../i18n';

export const IMAGE_MESSAGES: Dictionary = {
  fr: {
    'image.error.unreadable': 'Cette image est illisible ou d’un format non pris en charge (formats lus : PNG, JPEG, WebP, GIF, BMP).',
    'image.error.decode': 'Cette image est abîmée ou incomplète : elle ne peut pas être affichée. Récupérez le fichier complet (téléchargement ou copie interrompu ?).',
    'image.warn.truncated': 'Fichier image incomplet : il s’arrête avant la fin de l’image (téléchargement ou copie interrompu ?). Une partie du plan peut manquer ou être grise : récupérez le fichier complet.',
    'image.sheet.default': 'Plan scanné',
    'image.warn.scale': 'Image sans échelle : posez la règle sur une cote connue (la plus longue possible), puis tracez le contour à la main. En dessous de 200 dpi, un scan est imprécis.',
    'image.warn.lowDpi': 'Ce scan est à {dpi} dpi seulement : en dessous de 200 dpi les mesures sont imprécises. Si possible, rescannez le plan à 300 dpi.',
    'image.warn.small': 'Image de petite taille ({width} × {height} px) : les traits fins seront difficiles à viser. Si possible, rescannez le plan à 300 dpi.',
    'image.warn.huge': 'Image très grande ({megapixels} mégapixels) : l’affichage peut être lent.',
  },
  de: {
    'image.error.unreadable': 'Dieses Bild ist nicht lesbar oder hat ein nicht unterstütztes Format (gelesen werden PNG, JPEG, WebP, GIF, BMP).',
    'image.error.decode': 'Dieses Bild ist beschädigt oder unvollständig und kann nicht angezeigt werden. Bitte die vollständige Datei besorgen (Download oder Kopie abgebrochen?).',
    'image.warn.truncated': 'Bilddatei unvollständig: sie endet vor dem Bildende (Download oder Kopie abgebrochen?). Ein Teil des Plans kann fehlen oder grau sein: bitte die vollständige Datei besorgen.',
    'image.sheet.default': 'Gescannter Plan',
    'image.warn.scale': 'Bild ohne Maßstab: bitte das Lineal an ein bekanntes (möglichst langes) Maß anlegen und den Umriss von Hand zeichnen. Unter 200 dpi ist ein Scan ungenau.',
    'image.warn.lowDpi': 'Dieser Scan hat nur {dpi} dpi: unter 200 dpi sind die Messungen ungenau. Wenn möglich, den Plan mit 300 dpi neu scannen.',
    'image.warn.small': 'Kleines Bild ({width} × {height} px): feine Linien sind schwer zu treffen. Wenn möglich, den Plan mit 300 dpi neu scannen.',
    'image.warn.huge': 'Sehr großes Bild ({megapixels} Megapixel): die Anzeige kann langsam sein.',
  },
};

registerMessages(IMAGE_MESSAGES);

/** Texte du lecteur dans la langue demandée. */
export function msg(lang: Lang, key: string, params?: Record<string, string | number>): string {
  return t(lang, key, params);
}
