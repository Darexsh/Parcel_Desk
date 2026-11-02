import type { Stage } from '../../generated/catalog.js';
import type { CarrierStatus } from '../result/index.js';

/** Where an English return goes back to. */
const ORIGIN = String.raw`(?:the |its |their )?(?:sender|shipper|origin)\b`;
/** A return to come, under way, negated or uncertain. */
const ENGLISH_RETURN_UNDER_WAY = new RegExp(String.raw`\breturn(?:ing)? (?:back )?to ${ORIGIN}|\b(?:will|would|should|shall|must|may|might|can|could|ought to|needs? to|to) (?:(?:not|never|yet|still|already|soon|shortly|eventually|possibly|probably) )*(?:be|have been) returned (?:back )?to ${ORIGIN}|\b(?:not|never)(?: yet| already| still)? (?:(?:have|has|be|been|being) )*returned (?:back )?to ${ORIGIN}|\bbeing returned (?:back )?to ${ORIGIN}|\b(?:on (?:its|the) way|in transit|en route) back to ${ORIGIN}|\breturn (?:has been |was |is )?(?:initiated|requested|started|in progress|under ?way)\b|\b(?:start(?:s|ed|ing)?|begin(?:s|ning)?|began) (?:the |a )?return(?:ing)?\b`);

/** Instructions, uncertainty and a return in progress do not prove sender delivery. */
export function nonterminalEnglishReturn(description: string): boolean {
  const text = description.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ')
    .replace(/\bwon't\b/g, 'will not').replace(/\bshan't\b/g, 'shall not')
    .replace(/\bcan't\b|\bcannot\b/g, 'can not').replace(/\b([a-z]+)n't\b/g, '$1 not');
  // Bind the negative or modal to this sender-delivery phrase. A previous
  // failed recipient delivery does not negate an affirmative sender return.
  if (/\b(?:will|would|should|shall|must|may|might|can|could|ought to|needs? to|to) (?:(?:not|never|yet|still|already|soon|shortly|eventually|possibly|probably) )*(?:be|have been) delivered (?:back )?to (?:the )?(?:sender|shipper)\b|\b(?:not|never)(?: yet| already| still)? (?:(?:have|has|be|been|being) )*delivered (?:back )?to (?:the )?(?:sender|shipper)\b|\bbeing delivered (?:back )?to (?:the )?(?:sender|shipper)\b/.test(text)) return true;
  return ENGLISH_RETURN_UNDER_WAY.test(text);
}

function comparable(description: string): string {
  return description.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[’‘]/g, "'").replace(/ł/g, 'l').replace(/[_–—-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
}

// One character of the same sentence: a dot inside a date or "a.m." does not end it.
const SENTENCE = String.raw`(?:[^.;!?]|\.(?=\S))`;
/**
 * A delivery still to come: a forecast, a notice, an instruction or a
 * condition such as paying duties, from its verb to the end of the sentence.
 * Delivery back to the sender is a return and stays with the return rules.
 */
const DELIVERY_FORECAST = new RegExp(`(?:${[
  String.raw`\b(?:will|would|shall|should|may|might|must|won't|can(?! ?not\b)|could(?! not\b))(?: (?:not|now|then|still|also|likely|probably|possibly|hopefully|soon|shortly|only|normally|usually|again|today|tomorrow))* be delivered\b(?! (?:back )?to (?:the )?(?:sender|shipper)\b)`,
  // An estimate: "Your parcel is estimated to be delivered on: <date>".
  String.raw`(?:\b(?:is|are|was|were|has been|have been|had been) (?:now |still |also )?)?\b(?:estimated|expected|scheduled|planned|forecast(?:ed)?|projected|due) to be delivered\b(?! (?:back )?to (?:the )?(?:sender|shipper)\b)`,
  String.raw`\b(?:sera|seront|serait|seraient|va etre|vont etre|doit etre|doivent etre|devrait etre|devraient etre|pourra etre|pourront etre|pourrait etre)(?: \w+){0,2}? livree?s?\b(?! a (?:l'|son |leur |votre )expediteur)`,
  String.raw`\b(?:wird|werden|soll|sollte|sollen|sollten)\b(?!${SENTENCE}*?\babsender\b)${SENTENCE}*?(?<!\bnicht )\bzugestellt\b`,
  String.raw`\bvoraussichtlich\w*\b${SENTENCE}*?\b(?:zugestellt|zustellung)\b|\b(?:zustellung|zustelltermin) (?:(?:ist|erfolgt) )?(?:voraussichtlich|geplant)\b`,
  String.raw`\b(?:sara|saranno|verra|verranno|potra essere|potrebbe essere|dovrebbe essere|dovra essere)(?: \w+){0,2}? consegnat[oaie]\b(?! al mittente)`,
  String.raw`(?<!\bnao )\b(?:sera|seran|serao|va a ser|van a ser|vai ser|vao ser)(?: (?:hoy|manana|hoje|amanha|pronto|proximamente|brevemente|en breve|em breve))? (?:entregad[oa]s?|repartid[oa]s?|entregues?)\b(?! (?:al|ao|a la|a) (?:remitente|remetente|origen|origem)\b)|\bse (?:le |te |lo |la |les )?entregaran?\b`,
].join('|')})${SENTENCE}*`, 'g');

/**
 * What a description reports besides the delivery it announces, in the
 * comparable form the language rules read, or undefined when it announces
 * none. Such a notice is no movement: "Arrived at the depot, will be
 * delivered tomorrow" is in transit and "Will be delivered tomorrow" has no
 * stage, so the previous one stands.
 */
export function deliveryForecastRemainder(description: string): string | undefined {
  const text = comparable(description);
  const rest = text.replace(DELIVERY_FORECAST, ' ');
  return rest === text ? undefined : comparable(rest.replace(/^[\s,;:.!?]+|[\s,;:]+$/g, ''));
}

/** The sender a French, German, Italian, Dutch or Polish return goes back to, after its preposition. */
const SENDER = String.raw`(?:(?:a|chez|vers) (?:l'|son |leur |votre )expediteur|(?:an (?:den )?|zum |zu (?:den |dem )?|dem |den )absender|(?:al|verso il) mittente|(?:naar|bij|aan) (?:de )?afzender|do nadawcy)\b`;
/**
 * A return announced, under way or negated in French, German, Italian, Dutch,
 * Polish, or Spanish and Portuguese instructions: the parcel is not back yet
 * ("Il va être retourné à l'expéditeur", "Retour en cours", "Die Sendung wird
 * an den Absender zurückgesendet", "Devolver a origen").
 */
const RETURN_UNDER_WAY = new RegExp([
  String.raw`\b(?:sera|seront|serait|seraient|va etre|vont etre|doit etre|doivent etre|devrait etre|devraient etre|pourra etre|pourront etre|pourrait etre|en train d'etre)(?: \w+){0,2}? (?:retourne|renvoye|reexpedie|restitue|rendu|livre|remis)e?s? ${SENDER}`,
  String.raw`\bn'(?:a|ont|est|sont)(?: toujours)? (?:pas|jamais)(?: encore)? (?:ete )?(?:retourne|renvoye|restitue|rendu|livre|remis)e?s? ${SENDER}`,
  String.raw`\b(?:va|vont|doit|doivent) (?:\w+ )?(?:retourner|repartir|revenir) ${SENDER}|\ben (?:cours de |cours d'acheminement )?(?:retour|renvoi|reexpedition)\b|\b(?:en (?:cours d'acheminement|route)|achemine) ${SENDER}|\bretour (?:a l'expediteur |vers l'expediteur |expediteur )?(?:en cours|initie|demande|programme|prevu)\b|\bretour (?:(?:a|vers|chez) l')?expediteur\b(?! (?:effectue|termine|livre|abouti|receptionne|distribue|remis)e?s?\b)`,
  String.raw`\b(?:wird|werden|soll|sollte|sollen|muss|kann)(?: (?!(?:und|oder|wurde|wurden|ist|sind|war|hat)\b)[\w'-]+){0,6}? (?:retourniert|zuruck(?:gesendet|geschickt|gegeben|geleitet|befordert)|absender (?:\w+ )?(?:zugestellt|ubergeben|gesendet|geschickt))\b|\bauf dem (?:ruckweg|weg zuruck)\b|\b(?:rucksendung|retoure) (?:an (?:den )?absender )?(?:eingeleitet|veranlasst|beauftragt|angekundigt|unterwegs|in bearbeitung)\b|\b(?:zuruck|rucksendung|retoure) an (?:den )?absender\b(?! (?:\w+ )?(?:zugestellt|ubergeben|ausgehandigt|ausgeliefert|abgeschlossen|erfolgt)\b)|\ban (?:den )?absender zuruck\b`,
  String.raw`\b(?:sara|saranno|verra|verranno|deve essere|dovra essere|dovrebbe essere|potra essere|potrebbe essere|sta per essere)(?: \w+){0,2}? (?:restituit|res|rinviat|rispedit|ritornat|consegnat)[oaie] ${SENDER}|\bin (?:corso di |fase di )?(?:restituzione|rientro|reso|ritorno)\b|\breso (?:al mittente )?(?:in corso|avviato|iniziato)\b|\bin (?:viaggio|transito) ${SENDER}|\b(?:ritorno|restituzione) al mittente\b(?! (?:effettuat|completat|avvenut|conclus)[oa]\b)`,
  String.raw`\b(?:wordt|worden|zal|zullen|gaat)\b(?: \w+){0,4}? (?:(?:teruggestuurd|teruggezonden|geretourneerd|retour (?:gestuurd|gezonden)|terug (?:gestuurd|gezonden))\b|(?:afgeleverd|bezorgd) (?:bij|aan) de afzender\b|(?:bij|aan) de afzender (?:afgeleverd|bezorgd)\b)|\bonderweg (?:terug )?${SENDER}|\bretour (?:naar (?:de )?afzender )?(?:onderweg|in behandeling)\b|\b(?:retour|terug) (?:naar |aan )?(?:de )?afzender\b(?! (?:\w+ )?(?:afgeleverd|bezorgd|ontvangen)\b)`,
  String.raw`\b(?:zostanie|zostana|bedzie|beda)(?: \w+){0,2}? (?:zwrocon|odeslan|doreczon|zwracan)[aeyi] ${SENDER}|\bzwrot (?:przesylki )?do nadawcy\b(?! (?:zakonczon|doreczon|zrealizowan)\w*)|\bw drodze (?:powrotnej )?do nadawcy\b|\bprzekazan[aeyi] do zwrotu\b`,
  String.raw`\bdevolver (?:al|a|a la|ao) (?:remitente|remetente|origen|origem)\b|\b(?:retornando|regresando|volviendo) (?:al|a|ao) (?:remitente|remetente|origen|origem)\b`,
].join('|'), 'g');
/** A parcel back with its sender in those languages, also worded as a delivery to the sender. */
const RETURN_COMPLETED = new RegExp([
  String.raw`\b(?:retourne|renvoye|restitue|rendu|livre|remis|distribue)e?s? ${SENDER}`,
  String.raw`\b(?:an (?:den )?|dem )absender (?:\w+ )?(?:zugestellt|ubergeben|ausgehandigt|ausgeliefert)\b`,
  String.raw`\b(?:consegnat|restituit|recapitat|riconsegnat)[oaie] al mittente\b`,
  String.raw`\b(?:teruggestuurd|teruggezonden|geretourneerd|retour (?:gestuurd|gezonden)|terug (?:gestuurd|gezonden))(?: \w+){0,2}? (?:naar|aan) (?:de )?afzender\b|\b(?:afgeleverd|bezorgd|aangeboden) (?:bij|aan) de afzender\b`,
  String.raw`\b(?:zwrocon|doreczon|odeslan|wydan)[aeyio] (?:do )?nadawcy\b|\bodebran[aeyi] przez nadawce\b|\bzwrot (?:przesylki )?do nadawcy (?:zakonczon|doreczon|zrealizowan)`,
].join('|'));

/**
 * A return still to come or under way, unless the same scan also says the
 * parcel reached its sender ("Colis en retour, livré à l'expéditeur").
 */
function returnUnderWay(text: string): boolean {
  const rest = text.replace(RETURN_UNDER_WAY, ' ');
  return rest !== text && !RETURN_COMPLETED.test(rest);
}

/** What a carrier does once it has the parcel, or to take it. */
const CARRIER_STEP = String.raw`(?:dispatched|despatched|shipped|sent|received|accepted|processed|handed (?:over|in)|posted|picked up|collected)\b`;
/** A handover to a carrier or courier, not to the recipient's side or to customs. */
const HANDED_TO_CARRIER = String.raw`handed (?:over )?to (?!(?:the |a |an |your )?(?:recipient|addressee|consignee|customer|receiver|neighbou?r|customs|you|person)\b)`;
/** A carrier by its brand, as handovers to one are worded. */
const CARRIER_BRAND = String.raw`(?:gls|dpd|dhl|ups|fedex|tnt|hermes|colissimo|chronopost|brt|sda|inpost)\b`;
/** A place a carrier delivers to, worded after the brand or noun of its network: "DHL Packstation". */
const CARRIER_PLACE = String.raw`(?:packstation|paketstation|paketshop|parcelshop|shop|filiale|access point|pick ?up|locker|consigne|relais|restante|fermopoint|point|punto|box|station)\b`;
/** A carrier named on its own, not one of its places. */
const NOT_A_PLACE = String.raw`(?! ${CARRIER_PLACE})`;
/**
 * The same handover negated in French ("n'a pas encore été remis à GLS"),
 * German ("wurde noch nicht an GLS übergeben", or a heading such as "Paket
 * noch nicht an DPD übergeben") and Italian ("non è ancora stato affidato a
 * GLS"): one that has not happened, to a carrier or an operator, not one that
 * cannot or will not happen, nor one to the carrier's shop, locker or pickup
 * point.
 */
const NOT_HANDED_TO_CARRIER = [
  String.raw`(?:\bn'(?:a|ont)(?: toujours)? (?:pas|jamais)(?: encore)? ete|\bpas encore) (?:remis|confie)e?s? (?:a|au|aux) (?:(?:la|le|les) |l')?(?:(?:transporteur|livreur|coursier|messagerie|operateur|prestataire)s?|poste|${CARRIER_BRAND})\b${NOT_A_PLACE}`,
  String.raw`(?:\b(?:wurde|wurden|ist|sind|war|waren)\b(?: [\w'-]+){0,4}? |(?:^|[.;:] )(?:(?:das|die|der|ihr|ihre) )?(?:[\w-]+ )?(?:noch )?)nicht an (?:(?:den|die|das|dem|der|unseren|unsere|unserem) )?(?:[\w-]+ )?(?:zusteller|paketzusteller|paketdienst|kurier|kurierdienst|versanddienst|spediteur|post|${CARRIER_BRAND}) ubergeben\b(?! werden)`,
  String.raw`\bnon (?:(?:e|sono|ancora|stat[oaie]|mai) )*affidat[oaie] (?:(?:a|ad|al|allo|alla|ai|agli|alle) |all')(?:corrier[ei]|vettor[ei]|trasportator[ei]|spedizionier[ei]|operatore|posta|poste|${CARRIER_BRAND})\b${NOT_A_PLACE}`,
].join('|');
/**
 * A step the carrier has not taken yet ("not yet received", "not dispatched
 * yet") or a handover that has not happened ("has not been handed over to
 * GLS"), from the negation to the end of its sentence.
 */
const NOT_YET = new RegExp(String.raw`(?:\bnot (?:yet (?:been )?${CARRIER_STEP}|(?:been )?${CARRIER_STEP}(?: \w+){0,3}? yet\b)|(?:\bnot|n't)(?: been)? ${HANDED_TO_CARRIER}|(?:\bnot|n't) yet(?: been)? ${HANDED_TO_CARRIER}(?!(?:the |a |an |your )?(?:[\w-]+ )?${CARRIER_PLACE})|${NOT_HANDED_TO_CARRIER})${SENTENCE}*`, 'g');

/** A handover the carrier made, not a pickup order passed on or the sender's own hand-in. */
const HANDED_TO = String.raw`(?<!\b(?:(?:pick ?up|collection) (?:order|request)|sender|shipper|seller|merchant|consignor)(?: has| have)?(?: been)? )\bhanded (?:over )?to `;
/**
 * A courier no name or role sets apart: the one delivering the parcel. A
 * "SingPost courier", a "courier company" or The Courier Guy is another network.
 */
const COURIER = String.raw`(?:(?:the|a|an|our|your) )?(?:delivery )?couriers?\b(?! (?:compan|service|partner|network|guy\b))`;
const HANDED_TO_COURIER = new RegExp(`${HANDED_TO}${COURIER}`);
const HANDED_TO_NETWORK = new RegExp(String.raw`${HANDED_TO}(?!${COURIER})(?:the |a |an |our |your )?(?:[\w-]+ ){0,2}?(?:courier|carrier)s?\b`);

/** Customs or clearance named in any language. */
const CUSTOMS = /customs|clearance|\bclearing agen(?:cy|t)\b|douan|formalites (?:d')?(?:import|export)|zoll|dogan|\b(?:des)?aduan[ae]|alfandeg|\bceln|government agency|autorite gouvernementale|staatliche behorde|autorita governativa/;
/** The side of customs a scan may name: "import", "export", "import/export". */
const CUSTOMS_SIDE = String.raw`(?:(?:import|export)(?:\/(?:import|export))? |local |destination |origin )?`;
/**
 * Clearance that has not happened yet: negated, pending, announced or bound
 * to a condition ("once released from customs"). Each phrase names customs or
 * clearance itself, so a notice about something else passes on.
 */
const CUSTOMS_PENDING = new RegExp([
  String.raw`attend d'etre libere|attente de liberation|wartet auf.*freigabe|attesa di svincolo`,
  String.raw`(?:customs|clearance).*\bnot\b.*(?:clear|complet|releas)|customs (?:not cleared|clearance not completed)|not.*released by customs`,
  String.raw`(?:\bnot|n't|\bnever|\byet to)\b(?: (?:yet|been|be|being|have|has|had|fully|still))* (?:released|cleared|left|exited|out of|passed)\b${SENTENCE}*?\bcustoms\b`,
  String.raw`\b(?:will|would|shall|should|may|might|must|can|could|once|when|until|till|before|unless|as soon as|needs? to|has to|have to|yet to|waiting to|expected to|about to)\b(?: \w+){0,3}? (?:be |been |get |gets |is |are |has been |have been )?(?:released|cleared)\b${SENTENCE}*?\bcustoms\b`,
  String.raw`\b(?:customs|clearance)\b${SENTENCE}*?\b(?:will|would|shall|should|may|might|must|can|could|once|when|until|till|before|unless|as soon as|needs? to|has to|have to|yet to|waiting to|expected to|about to|to)\b(?: \w+){0,2}? (?:be |been |get |gets |is |are |has been |have been )?(?:released|cleared|completed?|finished|done)\b`,
  String.raw`\b(?:be|being) (?:released|cleared) (?:from |by |through |out of )?(?:the )?${CUSTOMS_SIDE}customs\b|\bclearance (?:is )?(?:in progress|ongoing|under way|underway)\b|\b(?:be|being) customs cleared\b`,
  String.raw`(?:\bnot|n't|\bnever|\b(?:yet|need|needs|has|have) to|\b(?:will|would|shall|should|may|might|must|can|could|once|when|until|till|before|unless))\b(?: \w+){0,3}? (?:completed?|finished) (?:the |its )?${CUSTOMS_SIDE}customs clearance\b`,
  String.raw`dedouanement.*(?:non termine|pas termine)|\b(?:pas|non|jamais)\b(?: (?:encore|ete|etre|completement|totalement))* (?:dedouane|(?:sorti|libere)e?s? (?:de |par )?(?:la )?douane)|\b(?:sera|seront|serait|va etre|vont etre|doit etre|doivent etre|devra etre|devrait etre|pourra etre|en attente d'etre)(?: \w+){0,2}? (?:dedouane|libere)`,
  String.raw`zollabfertigung.*nicht abgeschlossen|nicht.*zoll.*freigegeben|\bnicht (?:\w+ )?verzollt\b|\b(?:wird|werden|muss|mussen|soll|sollen|kann|konnen)\b${SENTENCE}*?\bverzollt\b|\b(?:verzollung|zollabfertigung|zollfreigabe|zollkontrolle)\b${SENTENCE}*?\b(?:nicht|steht aus|ausstehend)\b`,
  String.raw`sdoganamento.*non completato|\bnon\b(?: \w+){0,3}? (?:sdoganat|uscit[oaie] dalla dogana|svincolat)|\b(?:sara|saranno|verra|verranno|deve essere|devono essere|dovra essere|in attesa di essere|attende di essere)(?: \w+){0,2}? sdoganat`,
  String.raw`\b(?:no|sin)\b(?: \w+){0,3}? (?:(?:liberad|despachad)[oa]s?|salido|salio|sale|salir) (?:por|de|en|desde) (?:la )?aduana|\b(?:sera|seran|va a ser|van a ser|debe ser|deben ser|pendiente de|en espera de|a la espera de|esperando)\b(?: \w+){0,2}? (?:(?:liberad|despachad)[oa]s?|liberacion|despacho|salida)\b${SENTENCE}*?\baduan[ae]`,
  String.raw`\bnao\b(?: \w+){0,3}? (?:desalfandegad[oa]s?|desembaracad[oa]s?|(?:liberad[oa]s?|saiu) (?:pela|na|da|de) (?:alfandega|aduana|fiscalizacao))\b|\b(?:aguardando|a aguardar|aguarda|em espera de|pendente de|sera|serao|vai ser|deve ser)\b(?: \w+){0,2}? (?:desalfandeg|(?:liberad|liberacao|desembarac)\w*${SENTENCE}*?\b(?:alfandeg|aduan[ae]|fiscalizacao))`,
  String.raw`\b(?:nie|oczekuje na|czeka na|w trakcie|przed)\b(?: \w+){0,2}? (?:odpraw|zwolnion)\w*${SENTENCE}*?\b(?:celn|urzad)`,
].join('|'));
/** Clearance completed or the parcel released, in each language. */
const CUSTOMS_RELEASED = new RegExp([
  String.raw`\bclearance\b${SENTENCE}*?\b(?:complete|completed|finished|done|success|successful|successfully|concluded|granted|approved|obtained)\b`,
  // Verb first: "Shipment completed the customs clearance process at destination".
  String.raw`\b(?:completed|finished) (?:the |its )?${CUSTOMS_SIDE}customs clearance\b`,
  String.raw`\b(?:import|export) (?:procedures|formalities)\b${SENTENCE}*?\b(?:are|were|have been|has been) (?:now )?(?:complete|completed|finished|done)\b`,
  String.raw`(?:leaving|departed from|left|exited|exiting|out of|passed(?: through)?) (?:the )?${CUSTOMS_SIDE}customs\b(?! (?:to|for) (?:the )?(?:sender|shipper)\b)`,
  String.raw`completion of customs|released by (?:(?:the )?${CUSTOMS_SIDE}customs|a government agency|(?:the |a )?clearing agen(?:cy|t))|\breleased (?:from|out of|at) (?:the )?${CUSTOMS_SIDE}customs\b|\breturned from (?:the )?${CUSTOMS_SIDE}customs\b(?! to\b)`,
  // A release as a bare label, China Post's "出口海关/放行" in English: "Export customs release", "Export customs/release [City]".
  String.raw`^(?:(?:import|export) )?customs ?\/? ?release(?: ?(?:\[[^[\]]{1,60}\]|【[^【】]{1,60}】))?$`,
  String.raw`customs (?:(?:import|export) )?(?:cleared|(?:has |have )?released)|\bcustoms[.:] released$|\bcustoms (?:release|inspection|examination|check|control) (?:has been |was |is )?(?:granted|completed?|finished|done|passed)\b|\bcleared (?:through |by |the )?${CUSTOMS_SIDE}customs\b`,
  String.raw`formalites.*(?:terminee|achevee)|dedouanement.*(?:termine|acheve)|fin du dedouanement|\bdedouanement (?:(?:du colis|de (?:votre |l'|ce )?(?:colis|envoi)) )?(?:(?:a ete|est) )?(?:effectue|realise|reussi|valide|finalise)e?s?\b|\bdedouane(?:e|s|es)?\b|libere.*(?:douane|autorite)|douane.*libere|\bsorti(?:e|s|es)? de (?:la )?douane\b`,
  String.raw`zollabfertigung.*abgeschlossen|(?:zoll|behorde).*freigegeben|\bverzollt\b|\b(?:verzollung|zollabfertigung|zollkontrolle|zollprufung|zollformalitaten)\b${SENTENCE}*?\b(?:abgeschlossen|erledigt|beendet)\b|\b(?:verzollung|zollfreigabe) (?:ist |wurde )?(?:erfolgt|erteilt)\b(?! durch)|\b(?:den zoll|das zolllager|die zollstelle|das zollamt) verlassen\b`,
  String.raw`sdoganamento.*completato|completamento.*sdoganamento|svincolat.*(?:dogana|autorita)|\bsdoganat[oaie]\b|\bsdoganamento\b${SENTENCE}*?\b(?:effettuato|concluso|avvenuto|terminato|ultimato)\b|\bsvincolo (?:doganale )?(?:e )?(?:avvenuto|effettuato|concesso|completato|ottenuto)\b|\busci(?:to|ta|ti|te) dalla dogana\b|\bcontrollo doganale (?:e )?(?:superato|completato|concluso|terminato)\b`,
  String.raw`\b(?:liberad|despachad)[oa]s? (?:por|de|en|desde) (?:la |las )?aduanas?\b|\b(?:salida|salio|ha salido|sale) (?:de|desde) (?:la )?aduana\b|\b(?:tramites|despacho|gestion(?:es)?|proceso)(?: (?:de|del|en))?(?: (?:la |las |los )?aduanas?| aduaner[oa]s?)+ (?:(?:ha sido|han sido|fue|fueron) )?(?:finalizad|completad|terminad|concluid|realizad)[oa]s?\b`,
  String.raw`\b(?:liberad|desembaracad)[oa]s? (?:pela|na|da) (?:alfandega|aduana|fiscalizacao(?: aduaneira)?|receita federal)\b|\bdesalfandegad[oa]s?\b|\b(?:desalfandegamento|desembaraco(?: aduaneiro)?|fiscalizacao aduaneira|tramites aduaneiros|processo aduaneiro) (?:(?:foi|esta|foram) )?(?:concluid|finalizad|terminad|realizad|efetuad|efectuad)[oa]s?\b|\b(?:saiu|saida) (?:da|de) (?:alfandega|aduana)\b`,
  String.raw`\bodprawa celna (?:\w+ )?(?:zakonczona|zakonczyla sie|ukonczona)\b|\bodprawion[aey] celnie\b|\bzwolnion[aey] (?:przez urzad celny|z urzedu celnego)\b|\bopuscil[aoy]? urzad celny\b`,
].join('|'));
/** A parcel customs holds, detains or retains, in each language. */
const CUSTOMS_HOLD = new RegExp(String.raw`\bcustoms (?:hold|detention)\b|\b(?:held|on hold|detained|retained) (?:by|in|at) (?:the )?${CUSTOMS_SIDE}customs?\b|retenu en douane|vom zoll zuruckgehalten|fermo in dogana|retenido en aduana|retido na alfandega|zatrzyman[ay] przez (?:urzad celny|cel)`);
/** Import charges named on a scan: duties, import taxes or customs fees. */
const IMPORT_CHARGES = String.raw`(?:(?:import |customs )?dut(?:y|ies)(?: and (?:import )?tax(?:es)?)?|import tax(?:es)?|customs (?:charges|fees))`;
/** A parcel kept until the recipient pays its import charges: "held until duties and taxes are paid". */
const DUTIES_DUE = new RegExp([
  String.raw`\b(?:held|kept|on hold)\b(?: \w+){0,3}? (?:until|till|pending|for) (?:the )?(?:payment of )?(?:the )?${IMPORT_CHARGES}\b`,
  String.raw`\b(?:awaiting|waiting for|pending) (?:the )?(?:payment of )?(?:the )?${IMPORT_CHARGES}\b`,
  String.raw`\b${IMPORT_CHARGES} (?:are |is )?(?:due|owed|outstanding|unpaid|payable|to be paid|must be paid|payment (?:is )?(?:required|due|pending|outstanding))\b`,
].join('|'));
/** A customs problem or hold that has ended: the parcel moves on. */
const CUSTOMS_PROBLEM_ENDED = new RegExp([
  String.raw`\b(?:released|freed|cleared) (?:from|of) (?:the )?customs (?:hold|detention|inspection|examination)\b`,
  String.raw`\bcustoms (?:issue|problem|hold|detention)s? (?:(?:has|have) been |was |were |is |are )?(?:now )?(?:resolved|solved|lifted|released|cleared|removed|fixed)\b`,
  String.raw`\bprobleme (?:douanier|de douane) (?:a ete |est )?(?:resolu|regle|leve)e?\b|\bzollproblem (?:wurde |ist )?(?:behoben|gelost|geklart)\b|\bproblema doganale (?:e stato )?risolto\b|\bproblema (?:de|en la) aduana (?:ha sido |fue )?(?:resuelto|solucionado)\b|\bproblema (?:alfandegario|na alfandega) (?:foi )?resolvido\b`,
].join('|'));

/** A hold the recipient asked for, worded "at the recipient's request" in each language. */
const RECIPIENT_REQUEST = String.raw`(?:(?:at|per|by|upon|on|following|as per) (?:the )?(?:recipient|addressee|consignee|customer|receiver)(?:'s|s')? request|(?:at|per|by|upon|on|following) (?:the )?request of (?:the )?(?:recipient|addressee|consignee|customer|receiver)|requested by (?:the )?(?:recipient|addressee|consignee|customer|receiver)|(?:recipient|addressee|consignee|customer|receiver)(?: has)? requested\b|a la demande (?:du|de la) (?:destinataire|cliente?)|(?:auf|nach) (?:wunsch|anweisung|verlangen) (?:des|der) (?:empfangers|empfangerin|kunden|kundin)|auf (?:empfanger|kunden)wunsch|su richiesta del (?:destinatario|cliente)|(?:a|por) (?:peticion|solicitud|pedido) del (?:destinatario|cliente)|a pedido do (?:destinatario|cliente)|na (?:prosbe|zyczenie) (?:odbiorcy|adresata|klienta))`;
const HOLD = String.raw`\b(?:on hold|held|hold|holding|retenu(?:e|s|es)?|en attente|mise? en instance|zuruckgehalten|zuruckbehalten|angehalten|gelagert|trattenut[oaie]|fermo|in sosta|retenid[oa]s?|en espera|retid[oa]s?|zatrzyman[aey]|wstrzyman[aey])\b`;
const RECIPIENT_HOLD = new RegExp(`${HOLD}${SENTENCE}*?${RECIPIENT_REQUEST}|${RECIPIENT_REQUEST}${SENTENCE}*?${HOLD}`);
/** Where a held parcel waits for the recipient to collect it. */
const COUNTER = /post office|postal outlet|pick ?up|collection|counter|retail (?:location|outlet)|bureau de poste|point (?:de )?retrait|point relais|filiale|abholung|ufficio postale|ritiro|oficina|recogida|levantamento|agencia/;

/** The recipient's side by its role, not a service desk or an agent acting for it. */
const RECIPIENT = String.raw`(?:recipient|addressee|consignee|customer|receiver)s?\b(?!'| (?:service|care|support)\b)`;
/**
 * Where only a recipient collects a parcel. Parcel shops, service points and
 * access points also take in the drop-offs a courier then collects ("Picked
 * up at parcelshop", "collected from the ServicePoint"), so a collection there
 * has to name the recipient.
 */
const COLLECTION_PLACE = String.raw`(?:pick ?up (?:point|station|parcel ?shop|locker)|collection point|(?:parcel )?lockers?|packstation|(?:post office |postal )?counter)\b`;
const COLLECTED = String.raw`(?:picked up|collected)`;
/**
 * A parcel collected from its pickup point: by the recipient, the consignee or
 * the customer, or from a pickup point, locker or counter, in each language.
 */
const RECIPIENT_COLLECTED = new RegExp([
  String.raw`\b${COLLECTED}(?: [\w'-]+){0,6}? by (?:the |a |an |its |your )?${RECIPIENT}|^you(?: have|'ve)? (?:already )?${COLLECTED} (?:your|the) (?:parcel|package|shipment|item|order)\b|\b${RECIPIENT} (?:has |have )?(?:already )?${COLLECTED}\b|\b${COLLECTED} (?:from|at|in) (?:the |a |an |its |your |our )?(?:[\w-]+ ){0,2}?${COLLECTION_PLACE}`,
  String.raw`\bretire(?:e|s|es)?\b${SENTENCE}*? par (?:le |la |l'|son |sa )?(?:destinataire|cliente?)\b|\b(?:destinataire|cliente?) a retire\b|\bretire(?:e|s|es)? (?:au |en |dans (?:le |la |l'|un |une |votre |son )|a la |a l')(?:point (?:de )?retrait|point relais|relais|consigne|locker|bureau de poste)\b`,
  String.raw`\b(?:vom|von (?:der|dem)|durch (?:den|die)) (?:empfanger(?:in)?|kunden|kundin|adressaten|adressatin)\b${SENTENCE}*?\babgeholt\b|\b(?:empfanger(?:in)?|kunde|kundin) hat\b${SENTENCE}*?\babgeholt\b|\b(?:in|aus) (?:der|dem|einer|einem|ihrer|ihrem) (?:[\w-]+ )?(?:filiale|postfiliale|packstation|paketstation|abholstation|postamt)\b${SENTENCE}*?\babgeholt\b|^abholung(?: [\w-]+){0,4}? durch (?:den |die )?(?:empfanger(?:in)?|kunden|kundin|adressaten|adressatin)\.?$`,
  String.raw`\britirat[oaie]\b${SENTENCE}*? dal(?:la)? (?:destinatari[oa]|cliente)\b|\b(?:destinatari[oa]|cliente) ha ritirato\b|\britirat[oaie] (?:presso|in|al|nel|nella) (?:il |la |lo |l')?(?:punto (?:di )?ritiro|locker|ufficio postale)\b`,
  String.raw`\b(?:recogid|retirad)[oa]s? por (?:el |la )?destinatari[oa]\b|\bdestinatari[oa] (?:ya )?ha (?:recogido|retirado)\b|\b(?:levantad|retirad)[oa]s? pel[oa] destinatari[oa]\b|\bodebran[aeoy] przez (?:odbiorce|adresata)\b`,
].join('|'));
const COLLECT_VERB = String.raw`(?:picked up|collected|retire|abgeholt|ritirat|recogid|retirad|levantad|odebran)`;
/** A collection negated, still to come or made a condition, in each language. */
const COLLECTION_PENDING = new RegExp(String.raw`(?:\b(?:not|never|nothing|non|pas|jamais|nicht|nao|nie)\b|n't)${SENTENCE}*?${COLLECT_VERB}|\bno (?:(?:ha|han|fue|sido|se) )*(?:recogid|retirad)|\b(?:be|being|once|when|until|till|if|unless|before|etre|sera|seront|serait|essere|sara|saranno|verra|verranno)(?: [\w']+){0,3}? ${COLLECT_VERB}|\babgeholt (?:werden|wird)\b|\b(?:wird|werden|kann|konnen|muss|soll)\b${SENTENCE}*?\babgeholt\b`);
/** A pickup or collection that did not happen, the negation within a few words of the verb. */
const NOT_COLLECTED = new RegExp(String.raw`(?:\b(?:not|never|nicht|non|pas|nao|nie)\b|n't)(?: [\w']+){0,3}? ${COLLECT_VERB}|\bno (?:(?:ha|han|fue|sido|se) )*(?:recogid|retirad)|\buncollected\b`);
/** A courier, a driver or the sender's side collecting it, in each language. */
const COLLECTED_BY_CARRIER = new RegExp(String.raw`\b(?:by|from|par|de|du|vom|von|beim|dal|dalla|dallo|por|del|pelo|przez) (?:the |a |an |our |your |le |la |l'|den |der |dem |il |lo |el |o )?(?:[\w-]+ )?(?:couriers?|drivers?|carriers?|senders?|shippers?|sellers?|merchants?|consignors?|chauffeur|livreur|transporteur|coursier|expediteur|\w*(?:fahrer|kurier|zusteller|boten?)|absender|corriere|autista|vettore|mittente|repartidor|mensajero|transportista|remitente|motorista|estafeta|remetente|kuriera|nadawcy)\b(?!')`);
/**
 * A waybill or label generated for the parcel ("Waybill generated for <id>",
 * "AWB created"), from the start of the scan: the sender's paperwork, not the
 * parcel.
 */
const WAYBILL_CREATED = /^(?:the |your |a |new )?(?:(?:air ?|e )?way ?bill|awb|(?:shipping |shipment )?label(?: for (?:the |your |this )?(?:parcel|package|shipment|item|order))?)(?: (?:number|no\.?|#))? (?:(?:has been|have been|was|is) )?(?:successfully )?(?:generated|created|issued|printed)(?: successfully)?(?: for [a-z0-9#&./]+)?(?=$|[\s,;:.!?])/;
/**
 * A shipment, order or label cancelled, and nothing else in the scan, in each
 * language and Turkish ("İptal Edildi"). A cancelled return, pickup or hold,
 * which lets the parcel go on, is not one.
 */
const CANCELLED = new RegExp(String.raw`^(?:(?:the |your |this )?(?:shipment|parcel|package|order|consignment|item|delivery|(?:shipping )?label|envoi|colis|commande|livraison|sendung|paket|auftrag|bestellung|lieferung|spedizione|pacco|ordine|consegna|envio|paquete|pedido|entrega|encomenda|objeto|przesylka|paczka|zamowienie|gonderi|kargo|siparis) )?(?:(?:has been|was|is|a ete|est|wurde|ist|e stat[oa]|e|ha sido|fue|foi|zostal[ao]?) )?(?:cancell?ed|annulee?s?|storniert|annulliert|annullat[oa]|cancelad[oa]|anulad[oa]|anulowan[aeoy]|iptal edildi)$`);

/**
 * INFERRED language rules, not captured carrier codes. EN/FR/DE/IT/ES/PT/PL equivalents
 * are intuitive and overridable: an adapter must resolve verified codes and
 * carrier-specific semantics before consulting this fallback. No fixture import.
 */
export function trackingLanguageStage(description: string): Stage | undefined {
  const text = comparable(description);

  if (/^wird zugestellt$/.test(text)) return 'out_for_delivery';
  // DAI Post's scans in its own words, as universal providers relay them for a parcel not
  // filed under DAI Post. The delivery today is its out-for-delivery scan, not a forecast.
  if (/^we've received your delivery details\. we'll let you know as soon as your parcel is in our hands$/.test(text)) return 'registered';
  if (/^your parcel's checked in and being prepared for its journey$|^checked in at origin hub$/.test(text)) return 'accepted';
  if (/^your parcel is in the air and is heading your way$|^your parcel's left the transfer country and is back on the move$|^touchdown! your parcel has landed$|^collected from the airline for processing$|^your parcel's on an interstate journey\. we'll keep you updated as it travels$/.test(text)) return 'in_transit';
  if (/^it's happening, your parcel will be delivered today\. get ready$|^parcel out for final mile carrier delivery$/.test(text)) return 'out_for_delivery';
  if (/^parcel unsafe to leave at address$/.test(text)) return 'failed_attempt';
  // Royal Mail's delivery-round scans (EVGPD, EVKPD), as universal providers relay them: the
  // delivery today is its out-for-delivery scan, not a forecast.
  if (/^due to be delivered today(?: by\b.*)?$/.test(text)) return 'out_for_delivery';
  // Posta Slovenije's delivery round (N) and GLS's (INDELIVERY), as universal providers relay
  // them without the code: each carrier's map reads the sentence as out for delivery.
  if (/^the item is expected to be delivered today\.?$|^(?:the )?parcel is expected to be delivered during the day\.?$/.test(text)) return 'out_for_delivery';
  // Every rule below reads only what happened, never a delivery still to come.
  const reported = deliveryForecastRemainder(text);
  if (reported !== undefined) return reported ? trackingLanguageStage(reported) : undefined;
  // A waybill or label generated is registration, unless the rest of the scan
  // reports more: "Waybill generated, departed facility" is in transit.
  const paperwork = WAYBILL_CREATED.exec(text);
  if (paperwork) {
    const rest = text.slice(paperwork[0].length).replace(/^[\s,;:.!?]+/, '');
    return (rest ? trackingLanguageStage(rest) : undefined) ?? 'registered';
  }

  // Specific negatives, future steps and handoffs precede broad delivery words.
  if (nonterminalEnglishReturn(text)) return 'exception';
  if (returnUnderWay(text)) return 'exception';
  // Spanish and Portuguese returns still under way, announced or negated.
  if (/\b(?:en|em) (?:proceso de |processo de )?devolu(?:cion|cao)\b|^devolu(?:cion|cao)$|\bdevolu(?:cion|cao) (?:en curso|em curso|iniciada|solicitada|en transito|em transito)\b|\b(?:devolu(?:cion|cao)|retorno) (?:al|ao|a la|a) (?:remitente|remetente|origen|origem)\b(?! (?:completad|finalizad|concluid|entregad|entregue|realizad|efectuad|efetuad))|\ben camino (?:de vuelta |de regreso )?(?:al|hacia el) remitente\b|\b(?:a caminho (?:de volta )?(?:do|ao)|em transito para o) remetente\b|\b(?:siendo|sendo|a ser) (?:(?:devuelt|devolvid)[oa]s?|entregad[oa]s? al remitente|entregues? ao remetente)\b|\b(?:no|nao) (?:(?:ha|han|se|fue|foi|foram|sido|ser|sera|puede|pode|pudo|podido|todavia|aun|ainda|ya|ja) )*(?:(?:devuelt|devolvid)[oa]s?|entregad[oa]s? al remitente|entregues? ao remetente)\b|\b(?:sera|seran|serao|va a ser|vai ser|puede ser|pode ser|debe ser|deve ser|devera ser) (?:(?:pronto|proximamente|en breve|em breve|brevemente) )?(?:(?:devuelt|devolvid)[oa]s?|entregad[oa]s? al remitente|entregues? ao remetente)\b|\bse (?:le )?devolvera\b/.test(text)) return 'exception';
  if (RETURN_COMPLETED.test(text) || /\breturn (?:was |has been )?(?:successfully )?(?:handed (?:over|back)|delivered) to (?:the )?(?:sender|shipper)\b/.test(text)) return 'returned';
  if (/returned to (?:the )?sender|retour(?:ne)? a l'expediteur|zuruck an (?:den )?absender|an (?:den )?absender zuruck|retour a l'expediteur|reso al mittente|restituit[oa] al mittente|delivered (?:back )?to (?:the )?(?:sender|shipper)/.test(text)) return 'returned';
  if (/^(?:(?:envio|paquete|pedido|objeto|encomenda|pacote|remessa) )?(?:devuelt|devolvid)[oa]$|\b(?:devuelt|devolvid|retornad)[oa]s? (?:al|ao|a la|a) (?:remitente|remetente|origen|origem)\b|\bentregad[oa]s? al remitente\b|\bentregues? ao remetente\b|\bdevolu(?:cion|cao) (?:(?:al|ao|a la|a) (?:remitente|remetente|origen|origem) )?(?:completad|finalizad|concluid|entregad|entregue|realizad|efectuad|efetuad)/.test(text)) return 'returned';
  // A new attempt announced on its own reschedules the round; with the reason
  // the last one failed ("No payment, new delivery attempt") it stays a failed attempt.
  if (/^(?:a )?(?:new|next|another|further) (?:delivery )?attempt\b/.test(text)
    && !/\b(?:not|unable|fail(?:ed|ure)?|unsuccessful|missed|absent|closed|refused|nobody|no one)\b|n't\b/.test(text)) return 'in_transit';
  if (/not (?:yet )?delivered|\bun ?delivered\b|(?:could not|couldn't).*deliver|\bfailed to be delivered\b|\bdelivered to [^.;,]*\bfailure$|\bcan(?: ?not|'t) be delivered\b|unable to deliver|delivery (?:attempt|failed)|\bdelivery (?:was |is )?(?:not possible|impossible)\b|non livre|n'(?:a|avons) (?:pas )?pu.*(?:remis|remettre)|n'a pas pu etre (?:distribue|livre)|\bne (?:peut|pourra|pourrait|pouvait) (?:pas )?etre (?:distribue|livre)|livraison (?:impossible|echouee)|\bechec (?:de (?:la )?)?livraison|tentative de livraison|nicht zugestellt|nicht zugestellt werden|zustellung.*(?:fehlgeschlagen|nicht moglich)|zustellversuch|non consegnat[oa]|\bmancata consegna\b|non e stato possibile (?:consegnare|effettuare la consegna)|consegna (?:fallita|non riuscita)|tentativo di consegna/.test(text)) return 'failed_attempt';
  if (/\bno (?:(?:ha|han|hemos|se|le|lo|la|fue|sido|ser|es|era|pudo|puede|podido|posible|todavia|aun) )*(?:entregad[oa]s?|entregar(?:lo|la|le|se)?|repartid[oa]s?|realizar la entrega|efectuar la entrega)\b|\bsin entregar\b|\b(?:entrega|reparto) (?:fallid[oa]|imposible|no (?:(?:ha|han|se|fue|sido|ser|pudo|puede|podido) )*(?:realizad[oa]|efectuad[oa]|completad[oa]|posible|conseguid[oa]))\b|\bimposible (?:entregar|realizar la entrega|efectuar la entrega)\b|\bfallo (?:en la|de) entrega\b|\bintento fallido\b|\bintento de (?:entrega|reparto)\b(?! (?:programad|previst|para (?:hoy|manana|el)|manana|hoy))|\bnao (?:(?:foi|foram|ser|sera|pode|podemos|conseguimos|conseguiu|se|possivel|e|ainda|tem sido|esta|estava) )*(?:entregues?|entregar|efetuar a entrega|efectuar a entrega|realizar a entrega)\b|\bentrega (?:falhada|sem sucesso|impossivel|nao (?:(?:foi|pode|ser|sera|tem sido) )*(?:efetuada|efectuada|realizada|conseguida|concretizada|possivel))\b|\bfalha (?:na|de) entrega\b|\btentativa (?:de entrega|sem sucesso)\b(?! (?:agendada|prevista|programada|para (?:hoje|amanha)|amanha|hoje))|\bcarteiro nao atendido\b/.test(text)) return 'failed_attempt';
  // Missed rounds worded around the attempt, the card a missed round leaves, the
  // absent recipient or a closed business. A scheduled attempt is not a missed
  // one, nor is a sender pickup.
  if (!/\bpick ?up (?:attempt|was attempted|unsuccessful|failed)|attempted (?:to )?pick ?up/.test(text)
    && /(?:attempted|tried) to deliver|\bcard(?:ed| left)\b|\bwe(?: have|'ve)? missed (?:you|each other)\b(?![^.;!?]*\bready for (?:pick ?up|collection)\b)|\battempted delivery\b(?! (?:is )?(?:scheduled|planned|expected|tomorrow|will)\b)|unsuccessful delivery|delivery (?:was )?(?:un|not )successful|unable to complete (?:the |your |this )?delivery|(?<!\bif (?:the |your )?)\b(?:recipient|addressee|consignee|customer|receiver|user)(?: was| is)? (?:not (?:at home|home|available|present)|unavailable|absent)\b|absence of (?:the )?(?:recipient|addressee|consignee)|\bbusiness (?:was |is )?closed\b|\bpremises (?:(?:was|were) )?closed\b|destinataire absent|(?<!\ben cas d')\babsence du destinataire|(?:entreprise|societe) (?:etait |est )?fermee?\b|nicht angetroffen|(?:firma|betrieb|geschaft) (?:war |ist )?geschlossen|destinatario assente|(?:attivita|azienda|ditta) (?:era |e )?chiusa/.test(text)) return 'failed_attempt';
  // The same in Spanish and Portuguese ("Ausente"), where "recogida" and
  // "recolha" name the sender pickup and "si"/"caso" make absence a condition.
  if (!/\bintento de recogida\b|\brecogida (?:fallida|no realizada|no efectuada)\b|\btentativa de (?:recolha|coleta)\b|\b(?:recolha|coleta) (?:falhada|sem sucesso|nao (?:realizada|efetuada|efectuada))\b/.test(text)
    && !/\b(?:si|caso)\b[^.;:]*\b(?:ausen|nadie|ninguem|cerrad|fechad|no (?:esta|se encuentra)|nao (?:esta|se encontra))|\bse (?:o |a )?(?:destinatari[oa] |cliente )?(?:estiver|for|nao estiver)\b/.test(text)
    && /\bausen(?:te|tes|cia)\b|\b(?:destinatari[oa]|cliente|consignatari[oa]) (?:no (?:esta|estaba|se encuentra|se encontraba|disponible|presente)|nao (?:esta|estava|se encontra|se encontrava|disponivel|presente))\b|\bnadie en (?:casa|el domicilio)\b|\bninguem em casa\b|\b(?:establecimiento|negocio|empresa|comercio|tienda) (?:esta |estaba |se encontraba )?cerrad[oa]\b|\b(?:estabelecimento|empresa|loja|comercio|negocio) (?:esta |estava |se encontrava )?fechad[oa]\b/.test(text)) return 'failed_attempt';

  // A hold the recipient asked for is a delivery choice, not a problem: the parcel
  // waits for its new date, or at the counter when the scan names one.
  if (RECIPIENT_HOLD.test(text)) return COUNTER.test(text) ? 'ready_for_pickup' : 'in_transit';
  // So is a new delivery date someone asked for, even under FedEx's "Delivery exception".
  if (/\ba request was made to change (?:this|the|your) delivery date\b/.test(text)) return 'in_transit';
  // A change to the delivery details, relayed as just that (Cainiao's notice once the
  // local carrier has the parcel), moves no parcel back before transit.
  if (/^(?:the )?delivery (?:details|information) (?:(?:has|have) been |were |was )?updated$/.test(text)) return 'in_transit';
  // A local carrier's scan relayed as only "Package shipment", after its facility arrival.
  if (/^(?:package|parcel) shipment$/.test(text)) return 'in_transit';
  // Carrier-reported problems that are neither a missed attempt nor a return.
  if (/\b(?:damaged|broken in transit)\b|endommag|avarie|deterior|beschadigt|danneggiat|danad[oa]|danificad|uszkodzon/.test(text)) return 'exception';
  if (/\blost (?:in transit|package|parcel|shipment)?\b|colis perdu|envoi perdu|egare|verloren|verlust der sendung|smarrit|(?:paquete|envio) perdid|extraviad|zagubion|zaginion/.test(text)) return 'exception';
  if (/refused by (?:the )?(?:recipient|consignee)|\brefused\b|rejected by (?:the )?recipient|refus(?:e|ee)? par le destinataire|refus du destinataire|(?:colis|envoi|pli) refuse|annahme verweigert|verweigert|rifiutat|rechazad|recusad|odmowa przyjecia|odmowiono przyjecia/.test(text)) return 'exception';
  if (/address (?:incomplete|incorrect|invalid|insufficient|unknown)|(?:incorrect|incomplete|insufficient|wrong|invalid) address|(?:updated|correct(?:ed)?|complete) (?:delivery )?address (?:is )?(?:required|needed)|address(?:ee)? (?:unknown|cannot be located)|recipient unknown|adresse (?:incorrecte|incomplete|erronee|invalide|inconnue)|destinataire inconnu|(?:adresse|anschrift) (?:unvollstandig|falsch|unbekannt)|empfanger unbekannt|indirizzo (?:errato|incompleto|insufficiente|sconosciuto)|destinatario sconosciuto|direccion (?:incorrecta|incompleta|erronea|desconocida)|destinatario desconocido|endereco (?:incorreto|incompleto|errado|desconhecido)|destinatario desconhecido|adres (?:niepelny|nieprawidlowy|bledny)|nieznany adresat/.test(text)) return 'exception';
  if (CUSTOMS_PROBLEM_ENDED.test(text)) return 'in_transit';
  // A customs problem is an exception; a customs hold is customs at work.
  if (/customs (?:issue|problem)|probleme de douane|zollproblem|problema doganale|problema de aduana|problema (?:alfandegario|na alfandega)|problem celny/.test(text)) return 'exception';
  // So are import charges the recipient still owes: customs keeps the parcel until they are paid.
  if (CUSTOMS_HOLD.test(text) || DUTIES_DUE.test(text)) return 'customs';
  // A customs agent's step relayed under its name ("Customs agent: ready for pickup"): the parcel
  // waits for the agent at the airport, not for the recipient.
  if (/^customs (?:agent|broker)\s*:\s*ready (?:for|to be) (?:pick ?up|picked up|collect)/.test(text)) return 'customs';
  if (/(?:shipment|parcel|package) (?:is )?(?:held|blocked|on hold)|held pending|awaiting (?:your )?instructions|action required|(?:colis|envoi|pli) (?:bloque|retenu)|en attente d'instructions|action requise|sendung (?:blockiert|zuruckgehalten|angehalten)|wartet auf anweisungen|handlung erforderlich|spedizione (?:bloccata|trattenuta)|in attesa di istruzioni|envio (?:bloqueado|retenido)|en espera de instrucciones|accion requerida|encomenda (?:bloqueada|retida)|aguarda instrucoes|acao necessaria|przesylka (?:zatrzymana|wstrzymana)|oczekuje na instrukcje/.test(text)) return 'exception';
  if (/\bincident\b|\banomal(?:y|ie|ia)\b|delivery exception|shipment exception|irregularit|unregelmassigkeit|storung|vorfall|inconveniente|incidencia|nieprawidlowosc/.test(text)) return 'exception';
  // Carriers' own codes file a cancellation as an exception (17TRACK's
  // Exception_Cancel, Delhivery, Ninja Van, FedEx): it will not be delivered.
  if (CANCELLED.test(text)) return 'exception';

  // Sender data, not the parcel: "Shipment recorded by sender (data delivered)".
  if (/\b(?:data|information|details) delivered\b|\bdaten (?:ubermittelt|erhalten)|donnees (?:transmises|recues)/.test(text)) return 'registered';
  if (/\b(?:datos|informacion|dados|informacao|informacoes) (?:del envio |do envio |da encomenda )?(?:entregad[oa]s?|entregues?)\b/.test(text)) return 'registered';
  // Left for the carrier to admit, not admitted yet: Correos's "Depositado para
  // admisión", a parcel the sender dropped in a CityPaq locker.
  if (/\bpara (?:su )?(?:admision|admissao)\b|\b(?:deposited|dropped off)\b(?: [\w']+){0,8}? for (?:admission|acceptance)\b/.test(text)) return 'registered';
  // The recipient collecting the parcel ends the delivery, ahead of the drop-off
  // at the pickup point the scan may also name; the courier's or the sender's
  // collection is an acceptance below.
  if (RECIPIENT_COLLECTED.test(text) && !COLLECTION_PENDING.test(text) && !COLLECTED_BY_CARRIER.test(text)) return 'delivered';
  // "Delivered to" a pickup point or an intermediary is not delivery to the
  // recipient; a parcel already waiting at its pickup point outranks the
  // "sera remis" (will be handed over) that follows in La Poste's sentence.
  if (/delivered (?:to|at|in(?:to)?) [^.;,]*?(?:pick ?up (?:point|location)|pudo\b|parcel ?shop|access point|packstation|parcel locker|relay point|service ?point|collection point|retrieval point)|livre (?:au|en|dans (?:le|un|votre)) (?:point (?:de )?retrait|point relais|relais|consigne|locker)|(?:est|colis|envoi) disponible (?:dans|au|en) (?:votre |le |un )?(?:point (?:de )?retrait|point relais|relais|consigne|bureau de poste)/.test(text)) return 'ready_for_pickup';
  // A driver handing the parcel to a pickup shop after an attempt, or the shop
  // taking it over, as DPD words them: "Takeover by Pickup parcel shop".
  if (/\b(?:handed over to|takeover by|taken over by) (?:the |a )?pick ?up parcel ?shop(?![a-z\d])/.test(text)) return 'ready_for_pickup';
  if (/(?<!\b(?:sera|seran|serao|ser|sea|seja|for|siendo|sendo) )\bentregad[oa]s? (?:en|a|al) (?:el |la |un |una |su |tu )?(?:punto (?:de )?(?:recogida|conveniencia)|punto (?:pack|celeritas|collectt|nacex|inpost|dpd|gls|seur|mrw|ups|correos)|locker|taquilla|consigna|citypaq|parcel ?shop|buzon inteligente)\b|(?<!\b(?:sera|serao|ser|seja|for|sendo) )\bentregues? (?:no|num|na|numa|em|ao|a) (?:ponto (?:de )?(?:recolha|levantamento|pickup|entrega)|ponto (?:ctt|dpd|gls|inpost|ups|payshop)|cacifo|locker|loja ctt|payshop)\b/.test(text)) return 'ready_for_pickup';
  if (/delivered to (?:the |a |an |our )?(?:local |destination |final |next |onward |last mile )?(?:carrier|courier|airline|air carrier|airport|hub|depot|terminal|forwarder|(?:handling )?agent|(?:logistics|transport(?:ation)?|shipping|delivery|courier) (?:company|provider|partner|agent|service)|sorting (?:center|centre|facility)|(?:processing |distribution |transit |delivery |logistics )?(?:center|centre|facility)|post office(?! box)|postal (?:operator|service|office)|destination country)\b|delivered to (?:the )?(?:\w+ )?(?:post|poste|posta)\b(?! box| office box)|delivered to (?:dhl|dpd|gls|ups|fedex|usps|tnt|hermes|evri|colissimo|chronopost|quickpac|planzer)\b|handed (?:over )?to (?:the |a |an |our )?(?:local |last mile )?delivery partner|handed (?:over )?to (?:the |an )?(?:airline|air carrier)s?\b|en cours de livraison (?:au|en|vers (?:le|un|votre)) (?:point (?:de )?retrait|point relais|relais|consigne)|livre au transporteur|remis au transporteur local|an den lokalen zusteller ubergeben|consegnat[oa] al (?:corriere|vettore|trasportatore)/.test(text)) return 'in_transit';
  if (/(?<!\b(?:sera|seran|ser|sea|for) )\bentregad[oa]s? (?:(?:el|su|tu) (?:paquete|envio|pedido|bulto) )?(?:a|al|en) (?:el |la |un |una |nuestr[oa] )?(?:transportista|agencia (?:de )?(?:transporte|colaboradora|destino|origen)|operador(?: postal| logistico)?|mensajer(?:o|ia)|courier|empresa de (?:transporte|mensajeria|paqueteria)|compania (?:aerea|de transporte)|aerolinea|distribuidora?|centro (?:de )?(?:clasificacion|distribucion|tratamiento|logistico|operaciones)|almacen|delegacion|plataforma|hub|correos|seur|mrw|nacex|tipsa|ctt|gls|dhl|dpd|ups|fedex|tnt|envialia|zeleris|paack|celeritas|inpost)\b|\bentregad[oa] por (?:el remitente|la aerolinea|aerolinea)\b|(?<!\b(?:sera|serao|ser|seja|for) )\bentregues? (?:(?:a|o) (?:encomenda|envio|objeto) )?(?:a|ao|aos|as|na|no|nos|em) (?:transportadora|transportador|operador(?: postal| logistico)?|parceiro|companhia aerea|centro (?:de )?(?:distribuicao|tratamento|triagem|operacional|logistico)|armazem|plataforma|hub|ctt|correios|dpd|gls|dhl|ups|fedex|tnt|seur|mrw|nacex|tipsa|inpost)\b|\bentregue pelo remetente\b/.test(text)) return 'in_transit';
  // Cleared to leave the country of origin, whoever then carries it on.
  if (/\bready to leave (?:the )?foreign territory\b/.test(text)) return 'in_transit';
  // A carrier taking the parcel over, as Colis Privé words it: "Your package is taken care of by Colis Privé".
  if (/^(?:your |the )?(?:package|parcel|shipment) (?:is|has been|was) taken care of by\b/.test(text)) return 'in_transit';
  // A hand-over still to come to the delivery driver is not one to the carrier.
  if (/will (?:shortly |soon )?be handed(?! over to (?:your |the |a )?(?:delivery )?(?:driver|courier)\b)|bientot.*(?:confie|remis)|prochainement.*remis|wird.*(?:kurze|bald).*ubergeben|sara.*(?:breve|presto).*affidat/.test(text)) return 'registered';
  // The sender still has to hand the parcel over: "Pendiente de entregar a TIPSA", and CTT's
  // "Aguarda entrada nos CTT" as providers translate it, "Waiting for entry at CTT".
  if (/\bpendiente de (?:entregar|entrega|recepcion|admision|recibir) (?:a|al|en|por) (?:la |el )?(?:agencia|transportista|operador|correos|seur|mrw|nacex|tipsa|ctt|gls|dhl|dpd|ups|fedex|envialia|zeleris|paack|inpost|celeritas)\b|\bpendiente de (?:recepcion|admision)\b|\baguarda entrada\b|\bpendente de (?:rececao|recepcao|entrada)\b|\b(?:waiting|awaiting) (?:for )?entry at (?:the )?ctt\b/.test(text)) return 'registered';
  if (/or awaiting processing|ou en attente de traitement|oder wartet auf.*bearbeitung|o in attesa di elaborazione/.test(text)) return 'registered';
  // USPS's "Shipment Received, Package Acceptance Pending": the item reached USPS before its acceptance scan, as USPS's map reads it.
  if (/^shipment received,? package acceptance pending\b/.test(text)) return 'registered';
  if (/will be transported|\barrange (?:a )?(?:truck|train|rail|road) transfer\b|sera (?:transporte|achemine)|wird.*transportiert|sara trasportat/.test(text)) return 'in_transit';
  if (/will be available|sera disponible|(?:sera|va etre|doit etre) (?:distribue|remis|mis en (?:livraison|distribution))|wird.*verfugbar|sara disponibile|to be delivered|a livrer|noch zuzustellen|da consegnare|(?:once|when|as soon as) (?:the |your )?(?:shipment|parcel|package|item) is out for delivery|\bout for delivery soon\b/.test(text)) return 'in_transit';
  if (/\bestara disponi(?:ble|vel)\b|\bpor entregar\b|\bpendiente de (?:entrega|entregar|reparto)\b|\bpendente de entrega\b|\b(?:aguarda|aguardando|a aguardar) (?:a )?entrega\b|\bsera (?:enviad|transportad|expedid|encaminhad)[oa]s?\b/.test(text)) return 'in_transit';

  // "Order information has been received and ready for pickup", as SF Express words it: the
  // sender's parcel waits for the courier, not for the recipient.
  if (/\border (?:details|information|info|data) (?:(?:has|have) been |was |were )?received\b(?:[^.;]*)\bready (?:for|to be) (?:pick ?up|picked up|collect)/.test(text)) return 'registered';
  if (/ready for (?:pick ?up|collection)|ready to collect|(?:ready to|can(?: now)?) be (?:picked up|collected)\b(?! (?:by|from) (?:the |a |an |our |your )?(?:courier|carrier|driver|sender|shipper|seller|merchant|warehouse)\b)|available for (?:pick ?up|collection)|(?<!\bnot (?:yet )?)\bavailable (?:at|in|from) (?:the |a |an |your |our )?(?:[\w-]+ )?(?:retrieval point|pick ?up (?:point|location|station)|parcel ?shop|service ?point|access point|collection point|relay point|parcel locker)\b|\bwaiting for you (?:at|in) (?:the |a |an |your )?(?:[\w-]+ )?(?:collection point|pick ?up (?:point|location|station)|parcel ?shop|service ?point|access point|relay point|parcel locker|locker|post office)\b|awaiting (?:customer |recipient |your )?(?:pick ?up|collection)\b(?! (?:by|from) (?:the |a |an |our |your )?(?:local |destination |last[- ]mile )?(?:courier|carrier|driver|sender|shipper|seller|merchant|warehouse)\b)|pret.*(?:retrait|retire)|disponible.*(?:retrait|collecte)|vous attend (?:au|en|dans|chez|a)\b|mise? a disposition (?:au|en|dans|a)\b.*(?:point (?:de )?retrait|relais|consigne|locker|bureau de poste|agence)|jours? restants? pour (?:le )?retirer|abholbereit|zur abholung bereit|pront[oa] per il ritiro|disponibile per il ritiro|(?:deposited|depose|hinterlegt|depositat[oa]).*mypost24/.test(text)) return 'ready_for_pickup';
  if (/(?<!\b(?:no|nao|ya no|ja nao) (?:(?:esta|estara|se encuentra|se encontra|e|era|foi) )?)\bdisponi(?:ble|vel) (?:para (?:su |ser )?(?:recoger|recogida|recogid[oa]|retirar|retiro|retirada|retirad[oa]|levantamento|levantar|levantad[oa]|recolha|recolher)|(?:en|no|na|num|numa|em) (?:el |la |un |una |su |tu |nuestr[oa] )?(?:punto|oficina|tienda|locker|taquilla|consigna|citypaq|parcel ?shop|buzon inteligente|agencia|delegacion|sucursal|ponto|loja|cacifo|estacao|balcao|payshop|posto|unidade))\b|\blist[oa] para (?:su |ser )?(?:recoger|recogida|recogid[oa]|retirar|retiro)\b|\bpront[oa] (?:para|a) (?:ser )?(?:levantamento|levantar|levantad[oa]|recolha|recolher|retirada|retirar)\b|\b(?:ya )?(?:puede|puedes|podra|podras) (?:pasar a )?recoger(?:lo|la)?\b|\b(?:aguarda|aguardando|a aguardar) (?:o |a )?(?:levantamento|retirada)\b|\besperando (?:su|tu) recogida\b|\b(?:pendiente de|esperando|a la espera de) (?:ser )?recogid[oa] por (?:el |la )?destinatari[oa]\b/.test(text)) return 'ready_for_pickup';

  // Pre-advice can contain "data delivered", a recipient or a carrier handoff.
  if (/label (?:created|printed)|(?:created|generated) a (?:new )?(?:shipment |shipping )?label|etiquette.*(?:cree|imprime)|cree une etiquette|versandetikett.*(?:erstellt|gedruckt)|etikett erstellt|etichetta.*(?:creata|stampata)|creato un'etichetta|elektronisch|electroni(?:c|que|sch)|elettronic|pre.?advi[cs]|preannunciat|vorangemeldet|preannonce|data.*entered|donnees.*saisies|daten.*erfasst|dati.*inseriti|\bpre ?(?:registered|registration|registr?ad[oa]s?|registrat[oa]|enregistree?s?)\b|\bprerregistr(?:ad[oa]s?|o)\b|\bvorregistriert\b|\bwstepnie zarejestrowan[aey]\b/.test(text)) return 'registered';
  if (/\border (?:details|information|info|data) (?:(?:has|have) been |was |were )?(?:received|submitted|transmitted)\b|\breceived (?:your |the )?order (?:details|information|data)\b|\b(?:details|informations|donnees) de (?:la |votre )?commande (?:ont ete )?(?:recu|transmis)e?s?\b|\b(?:auftrags|bestell)daten (?:wurden |sind )?(?:erhalten|ubermittelt|eingegangen)\b|\b(?:dati|dettagli) (?:dell'ordine|ordine) (?:sono stati )?ricevuti\b|\b(?:datos|detalles|informacion) del pedido (?:han sido |fueron )?recibid[oa]s?\b|\b(?:dados|detalhes|informacoes?) d[oa] (?:pedido|encomenda) (?:foram )?recebid[oa]s?\b|\bdane zamowienia (?:zostaly )?(?:otrzymane|przyjete)\b|\botrzymano dane zamowienia\b/.test(text)) return 'registered';
  // The rtb56 trackers' first line, the parcel's electronic data received, as providers relay it.
  if (/^快件电子信息已经?收到/.test(text)) return 'registered';
  // GEODIS's notice that the sender's data reached it, as ParcelsApp relays it: "Transferred Data".
  if (/shipment information (?:received|sent to)|\binformation about the (?:shipment|parcel|package) (?:has been |was )?received\b|\bdata received\b|^transferred data$|(?:package|parcel|shipment) data (?:was |has been )?sent to|\bpre ?notification\b|informations d'expedition recues|sendungsinformationen erhalten|informazioni.*spedizione ricevute|(?:consignment|shipment|parcel|package) recorded by|envoi enregistre par|sendung.*absender.*erfasst|spedizione registrata dal/.test(text)) return 'registered';
  if (/\b(?:we're|we are) expecting (?:your|the) (?:parcel|package|item|shipment) to arrive with us\b/.test(text)) return 'registered';
  // GLS's shipment the sender created and has not entrusted to it yet, as GLS Italy and relays word it.
  if (/\bcreated by the sender\b.*\bwaiting for it to be (?:entrusted|handed(?: over)?) to us\b/.test(text)) return 'registered';
  // The shipment's pre-alert, its electronic notice: "Pre-alerted shipment enriched by PostNL management".
  if (/^pre[ -]?alerted (?:shipment|parcel|package|item|consignment)\b|^(?:the |your )?(?:shipment|parcel|package|item|consignment) (?:(?:has been|was|is) )?pre[ -]?alerted$/.test(text)) return 'registered';
  // A sender's notice, "Expected from <sender>"; a day or a time after "from" is a delivery window.
  if (/^expected from (?!\d{1,2}(?:[:.h]\d{2})?\s*(?:am|pm)?\b|(?:today|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b)\S/.test(text)) return 'registered';
  // Foxpost's new parcel, which the sender has not handed over yet.
  if (/\bletrejott a rendszerunkben\b.*\bfelado meg nem adta at\b/.test(text)) return 'registered';
  if (/preparation chez.*expediteur|preparation.*expediteur|preparazione.*mittente|being prepared.*sender|(?:shipper|sender)(?: that)? (?:they are|is|are) preparing|beim absender.*vorbereitet|warehouse of the sender|shippers warehouse|entrepot de l'expediteur|lager des absenders|magazzino del mittente|demande d'envoi.*prise en compte|collection request.*(?:received|recorded)|^(?:the |your )?collection (?:has been |was )?registered$|abholauftrag.*erfasst|richiesta.*ritiro.*registrata/.test(text)) return 'registered';
  // The sender's order or data reached the carrier, not the parcel: "Order submitted, pending to
  // receive", Royal Mail's "Sender preparing item", "Sender despatching item" and "Sender has despatched item", "Shipping info sent to BRT",
  // and a line's "Shipping Order Created".
  if (/\border submitted(?:,| and)? pending (?:to )?rece(?:iv|ipt)|\bshipment data uploaded\b|^sender preparing item\b|^sender (?:has despatched|despatching) item$|^shipping info(?:rmation)? sent to (?!(?:the |your? )?(?:recipient|customer|consignee|addressee|buyer)\b)|\bwe have received your shipment information\b|\bhemos recibido la informacion de su envio\b|\bwe will pick up (?:the|your) (?:package|parcel) from the sender\b|^booked for collection$|\bpending shipping by (?:the )?(?:seller|sender|shipper|merchant)\b|\bship(?:ment|ping) order created\b/.test(text)) return 'registered';
  // A Shenzhen forwarder's pre-advice from the shipper, before its warehouse has the parcel.
  if (/^forecast has been received$/.test(text)) return 'registered';
  // The carrier has not had the parcel yet: "Shipment not yet received or
  // processed". What else the scan reports still counts: "Arrived at hub; not
  // yet processed" is in transit, and a clearance delay stays with customs,
  // even worded within the step's own sentence ("Not handed over to the
  // carrier: awaiting customs clearance"), as a release there moves it on
  // unless it is still to come ("clearance not completed").
  if (!/\b(?:at|in|by) (?:the )?(?:destination|delivery|recipient|consignee|addressee|customer|customs|office of exchange)\b/.test(text)) {
    const rest = text.replace(NOT_YET, ' ');
    if (rest !== text) {
      return trackingLanguageStage(rest.replace(/^[\s,;:.!?]+|[\s,;:]+$/g, ''))
        ?? (CUSTOMS.test(text) ? (!CUSTOMS_PENDING.test(text) && CUSTOMS_RELEASED.test(text) ? 'in_transit' : 'customs') : 'registered');
    }
  }
  if (/^(?:reported|recorded|announced|item created|enregistre|annonce|erfasst|angekundigt|registrato|annunciato)$/.test(text)) return 'registered';
  // A shipment record the sender created ("Shipment created"), and nothing else.
  if (/^(?:(?:the |your |a |new )?(?:shipment|parcel|package|consignment|order|envoi|colis|expedition|commande|sendung|paket|auftrag|spedizione|pacco|ordine|envio|paquete|pedido|encomenda|przesylka|paczka|zamowienie|gonderi|kargo|siparis) )(?:(?:has been|was|a ete|wurde|e stat[oa]|ha sido|fue|foi|zostal[ao]?) )?(?:created|creee?s?|erstellt|angelegt|creat[oa]|cread[oa]|criad[oa]|utworzon[aey]|olusturuldu)$/.test(text)) return 'registered';
  // An order placed with the seller, before any shipment.
  if (/^(?:the |your |an? |new )?order (?:has been |was )?placed$/.test(text)) return 'registered';
  // The carrier recorded the shipment, in Spanish after a "notified" label ("Notificado - El envío ha sido
  // registrado") and in English.
  if (/^(?:notificado )?(?:el |la |su |tu )?(?:envio|paquete|pedido|encomienda) (?:ha sido|fue) registrad[oa]$/.test(text)
    || /^(?:the |your )?(?:shipment|parcel|package) (?:has been|was) registered$/.test(text)) return 'registered';

  // A completed clearance or release moves the parcel on; holds, inspections,
  // submissions and clearance still pending or negated stay with customs.
  if (/(?:国内|出口|进口|目的国)?清关中/.test(text)) return 'customs';
  if (CUSTOMS_PENDING.test(text)) return 'customs';
  if (CUSTOMS_RELEASED.test(text)) return 'in_transit';
  if (CUSTOMS.test(text)) return 'customs';

  if (/out for (?:physical )?delivery|\bout with (?:the |a |our |your )?(?:delivery )?(?:courier|driver)s?\b(?! for (?:pick ?up|collection|return))|being delivered|\bin delivery\b(?! (?:terminal|depot|cent(?:er|re)|office|facility|hub|station|base|area|point)s?\b)|(?:loading|loaded).*delivery vehicle|on (?:\w+ )?vehicle for delivery|\bon ?board for delivery\b|(?:courier|driver|delivery champion) has (?:the|your) (?:shipment|parcel|package|item)|\bcourier will deliver (?:the|your) (?:parcel|package|shipment|item) (?:soon|today)\b|^release (?:of (?:the )?(?:shipment|package|parcel) )?for delivery(?: abroad)?$|en cours de livraison|en livraison|de la livraison de (?:son|votre) colis ce jour|charg(?:e|ement).*vehicule de livraison|in zustellung|zustellfahrzeug.*(?:geladen|verladen)|(?:beladen|verladung).*zustellfahrzeug|in consegna|caric(?:at|amento).*veicolo.*consegna/.test(text)) return 'out_for_delivery';
  // "Reparto" alone is the round, but not the "unidad de reparto" it leaves from;
  // "distribuição" is the round, but not the "centro de distribuição".
  if (/^(?:en )?reparto$|\ben reparto\b|\b(?:siendo|sendo|a ser) (?:entregad[oa]s?|entregues?|repartid[oa]s?|distribuid[oa]s?)\b|\b(?:salida|salio|sale|ha salido) (?:a|para) (?:el )?reparto\b|\bruta de (?:reparto|entrega)\b|\ben proceso de entrega\b|\bvehiculo de reparto\b|\b(?:repartidor|mensajero|cartero|conductor) (?:ya )?(?:tiene|lleva) (?:tu|su|el|la) (?:paquete|envio|pedido|encomienda)\b|\bem distribuicao\b|\bsaiu para (?:a )?(?:entrega|distribuicao)\b|\bem (?:rota|processo|curso) de entrega\b|\bem entrega\b|\bveiculo de (?:entrega|distribuicao)\b|\b(?:carteiro|estafeta|motorista|entregador) (?:ja )?(?:tem|leva) (?:a|o) (?:sua |tua )?(?:encomenda|envio|objeto|pacote|volume)\b/.test(text)) return 'out_for_delivery';
  // Handed to the courier alone is the delivery round, as DHL eCommerce NL and
  // YunExpress file it, unless the scan names a pickup, a return or the sender.
  if (HANDED_TO_COURIER.test(text) && !/\b(?:pick ?up|collection|return|sender|shipper|seller|merchant|consignor)/.test(text)) return 'out_for_delivery';
  if (/\bdelivered\b|^final delivery$|delivery complete(?:d)?\b|delivery (?:was )?successful|(?:a ete|est) distribue|^(?:livre|livree)(?:$|[ ,])|(?:colis|envoi|est|a ete) livre|zugestellt|\bconsegnat[oa]\b|livraison effectuee|consegna completata/.test(text)) return 'delivered';
  // Left in the recipient's letterbox, as Postal Ninja relays PostNL's "Shipment in letterbox".
  if (/^(?:the |your )?(?:shipment|parcel|package|item) (?:(?:is|was|has been) )?(?:(?:placed|left|put) )?in (?:the |your |a )?(?:letter|mail) ?box$/.test(text)) return 'delivered';
  // A delivery still to come ("una vez entregado", "que se entregue", "quando
  // for entregue") is not one; Spanish "entregue" is also a subjunctive.
  if (!/\b(?:una vez|cuando|hasta que|antes de que|para que|en cuanto|tan pronto como|uma vez|quando|assim que|ate que|logo que)\b[^.;:]*\bentreg/.test(text)
    && /(?<!\b(?:sea|sean|fuera|fuese|ser|seja|sejam|fosse|for|forem|que|se) )\b(?:entregad[oa]s?|entregues?)\b|\bentrega (?:realizada|efectuada|efetuada|completada|concluida|finalizada)\b/.test(text)) return 'delivered';

  // A handover to another network, a carrier or a courier set apart, takes the parcel on.
  if (HANDED_TO_NETWORK.test(text)) return 'in_transit';
  // The same handover seen from the network that delivers the parcel, not the first carrier's acceptance.
  if (/(?<!\bnot (?:yet )?(?:been )?)\b(?:picked up|collected|received) by (?:the |a |our )?(?:last|final)[- ]mile (?:carrier|courier|(?:delivery )?partner|provider)s?\b/.test(text)
    || /^hand(?:ed )?over to (?:the )?(?:last|final)[- ]mile(?: (?:carrier|courier|(?:delivery )?partner|provider))?$/.test(text)) return 'in_transit';
  // Posting/collection by the carrier, not recipient pickup or data submission.
  if (/^(?:the |your )?(?:item|package|parcel|shipment) (?:has been |was |is )?(?:received for transport|(?:dropped off|deposited) by (?:the )?sender (?:at|with) (?:our |the |a )?postal partner)\b/.test(text)) return 'accepted';
  // A vehicle load and a gateway scan prove handling, but do not name the delivery round. So does an
  // office of exchange taking in mail from abroad, as a provider words Magyar Posta's "A bejövő
  // küldemény átvétele a kicserélőben".
  if (/^(?:load vehicle|scan ok gateway)$/.test(text)
    || /^(?:the )?item in process in office of exchange\b/.test(text)
    || /^acceptance of (?:the )?incoming (?:shipment|item|mail) at the exchange office$/.test(text)) return 'in_transit';
  // Speedy's scans as providers relay them: its courier's collection, then an
  // office's receipt and a handover to a partner abroad, as its own map reads them.
  if (/^courier pick up$/.test(text)) return 'accepted';
  // A Chinese forwarder's collection from the sender, as ParcelsApp relays it.
  if (/^shipment pick ?up$/.test(text)) return 'accepted';
  // China Post collecting an express item, as providers relay it with no carrier. For a parcel a
  // consolidator took first it is a hand-over on the way, so it reads in transit and never moves a
  // parcel back, as YunExpress's and PFC Express's maps read China Post's receipt of mail.
  if (/^中国邮政 ?已收取快件$/.test(text)) return 'in_transit';
  // China Post's arrival at the office it names in brackets, a processing centre or the delivery office, abroad too,
  // as providers relay it with no carrier: in transit, as YunExpress's, PFC Express's and DHLink's maps read it.
  if (/^邮件到达(?:处理中心|投递点)? ?【[^【】]{1,80}】$/.test(text)) return 'in_transit';
  // A forwarder relabelling a parcel under its next carrier's number, as ParcelsApp relays it with the carrier's
  // note: the parcel is in hand on its way. Without the note, a changed number may be data alone.
  if (/^tracking number changed, carrier note: (?:the )?package (?:was |has been )?relabell?ed$/.test(text)) return 'in_transit';
  // A Chinese courier's (业务员) collection from the sender, as providers translate it.
  if (/^(?:the )?salesperson (?:has )?(?:collects|collected|picks up|picked up) (?:the )?(?:package|parcel|shipment)$/.test(text)) return 'accepted';
  // Nova Poshta's English as providers relay it: the shipment registered, then its departure from the branch,
  // numbered or not.
  if (/^registered and being prepared$/.test(text)) return 'registered';
  if (/^left the branch(?: \d{1,3})?$/.test(text)) return 'in_transit';
  // nox's branch scans in Germany as Postal Ninja relays them, each followed by the remark nox's former
  // tracker showed beside it: arrival at a branch, then the branch loading it onward, in German or English.
  if (/^collo (?:in der nox niederlassung eingetroffen\. sendung eingetroffen|von der nox niederlassung weiterverladen\. sendung weiterverladen|is reloaded by the nox branch\. consignment reloaded)$/.test(text)) return 'in_transit';
  // TNT Italy's departure from the origin depot, and the US Postal Service's hand-off to the international
  // gateway after customs.
  if (/^la spedizione (?:e'|e) regolarmente partita$|^tendered to (?:the )?international gateway$/.test(text)) return 'in_transit';
  // InPost UK's scans as Ship24 relays them: the sender's drop-off in a locker or at a store, then a hub's
  // outbound scan.
  if (/^parcel stored by (?:the )?customer$/.test(text)) return 'accepted';
  if (/^scan out hub$/.test(text)) return 'in_transit';
  // Vinted Go's scan, as Postal Ninja relays it, for a sender who began a drop-off at a locker and did not
  // finish it: the parcel is still with the sender, between the label and the drop-off.
  if (/^attempted but unfinished drop[- ]?off at (?:the |a )?locker$/.test(text)) return 'registered';
  // A partner network taking the parcel over mid-journey, as ParcelsApp relays it between a post's export
  // scans and the destination's freight scans, and a line's US hub after the flight ("Parcel received by in
  // JFK01.").
  if (/^(?:(?:the |your )?(?:item|parcel|package|shipment) )?(?:(?:has been|was) )?received by (?:the |a |our )?partner carrier$|^(?:(?:the |your )?(?:item|parcel|package|shipment) )?received by in [a-z]{3}\d{2}\.?$/.test(text)) return 'in_transit';
  // MeiHoo Pegasus's scans at its operation centre, as 17TRACK relays them after the order: the centre handling
  // the package's data, which does not say it has the parcel, then the parcel about to leave the centre. The
  // Hualei platform's lines word the departure "Goods leave the operation center".
  if (/^operation cent(?:er|re) is processing (?:the )?(?:package|parcel|shipment) information$/.test(text)) return 'registered';
  if (/^(?:preparing to leave|(?:the )?goods leav(?:e|ing)) (?:the )?(?:[a-z]+ ){0,3}operation cent(?:er|re)$/.test(text)) return 'in_transit';
  // PostNL's international scans as providers relay them without its categories, read as Spring GDS's map reads
  // them: the item prepared before its bulk handover, then PostNL's acceptance centre taking it in.
  if (/^(?:the )?item is ready for shipment$/.test(text)) return 'registered';
  if (/^consignment received at (?:the )?postnl acceptance cent(?:re|er)$/.test(text)) return 'accepted';
  // PostNL's domestic labels as ParcelsApp relays them: the shipment announced but not yet at PostNL, then,
  // after its sorting, the parcel linked to a packaging tool for the journey abroad and crossing the border.
  if (/^shipment expected,? but not yet arrived or processed at postnl$/.test(text)) return 'registered';
  if (/^parcel linked to (?:a |the )?packaging tool$|^(?:your |the )?(?:parcel|package|shipment|item) has crossed the border$/.test(text)) return 'in_transit';
  // UPS's scans as providers relay them without its activity codes, read as UPS's own map reads them: a delivery
  // change the receiver asked for, carried out, and a wrong company or receiver name holding the delivery.
  if (/^as requested, (?:the )?(?:ups my choice®? )?delivery change (?:was|has been) completed$|^(?:the )?(?:delivery )?address (?:was|has been) changed as (?:the )?(?:receiver|recipient) requested$/.test(text)) return 'in_transit';
  if (/^the company or receiver name is incorrect\. this will delay delivery\b/.test(text)) return 'exception';
  // ePost Global's row a minute after the shipping data, as providers relay it, read as its own map reads it:
  // the label, not a scan.
  if (/^shipment in transit to (?:the )?epost global processing cent(?:er|re)$/.test(text)) return 'registered';
  if (/^(?:received in office|export to foreign provider)$/.test(text)) return 'in_transit';
  // Sent on to another country: "Sent abroad".
  if (/^(?:(?:the )?(?:shipment|parcel|package|item) )?(?:(?:has been|was) )?(?:sent|dispatched|forwarded) abroad$/.test(text)) return 'in_transit';
  // A post's departure from its country, as ParcelsApp words Poczta Polska's:
  // "Sending the package from Poland". Not a sender's drop-off at a point or shop.
  if (/^sending (?:the )?(?:package|parcel|item|shipment) from (?!.*\b(?:point|locker|shop|sender|branch)\b)[a-z][a-z .'-]{1,40}$/.test(text)) return 'in_transit';
  // Russian Post's operations as ParcelsApp words them: the item leaving the office that took it in, its
  // export or import as international mail, and its release from the country it leaves. A release names the
  // country alone, not a place or a hold.
  if (/^processing: left (?:the )?pickup location$|^(?:export|import) of international mail$/.test(text)) return 'in_transit';
  if (/^released from (?!(?:the|a|an|our|your)\b)(?!.*\b(?:customs|hold|storage|warehouse|office|branch|depot|hub|facility|cent(?:er|re)|point|locker|quarantine|inspection|sender|shipper)\b)[a-z][a-z .'-]{1,40}$/.test(text)) return 'in_transit';
  if (/^(?:posting\/collection|posted|origin scan)$|received at (?:our |the )?(?:[a-z]+ )?origin (?:office|facility|hub)|dropped off (?:after|before) (?:the )?latest drop ?off time/.test(text)) return 'accepted';
  // Turned away rather than taken in: "Package not accepted by sorting center".
  if (/(?:\b(?:not|never)|n't)(?: (?:be|been|being))? accepted\b/.test(text)) return 'exception';
  // Nor is a pickup that did not happen. A parcel left uncollected or one the courier failed to collect is an
  // exception, as the carriers' own maps file it. One yet to be collected waits for the carrier or the recipient,
  // whichever the scan names, and one that may not happen ("if not collected") names no stage.
  if (NOT_COLLECTED.test(text)) {
    if (/\b(?:if|unless|wenn|falls|si|qualora|caso)\b/.test(text)) return undefined;
    if (!/\b(?:yet|noch|encore|ancora|todavia|aun|ainda|jeszcze)\b/.test(text)) return 'exception';
    return COLLECTED_BY_CARRIER.test(text) ? 'registered' : new RegExp(RECIPIENT).test(text) ? 'ready_for_pickup' : undefined;
  }
  // A pickup still to come ("will be picked up") is not one either.
  if (/accepted|(?<!\b(?:be|being) )picked up|pick up was successful|^drop off$|pick ?up scan|prepared the package for return to ups or pickup by ups|handed (?:over )?to (?:dpd|gls)|package received at dhl|item booked|consignment was mailed|posted at a postal point|pris en charge|prise en charge|collecte.*(?:reussi|effectue)|recupere.*boite aux lettres|depose.*point postal|remis a (?:dpd|gls)|envoi.*depose|abholung.*erfolgreich|^(?:die sendung wurde )?erfolgreich abgeholt$|eingeliefert|an (?:dpd|gls) ubergeben|paket.*(?:angenommen|ubernommen)|ritiro.*(?:riuscito|effettuato)|pres[oa] in carico|affidat[oa] a (?:dpd|gls)|depositat.*punto postale|spedizione.*impostata/.test(text)) return 'accepted';
  // Taken in by the carrier: Royal Mail's "Item received by Royal Mail", a parcel shop's or a warehouse's
  // receipt, a forwarder's ("<company> has received the goods, <town>, <country>."), the sender's drop-off at a
  // SEUR pickup point, a collection carried out, and its English "Has been put into storage". A bare "Item
  // received" names no receiver and stays unread. The Hualei platform's arrival at a line's receiving point
  // (到达收货点) is a receipt too.
  if (/^到达收货点|^item received by royal mail$|\btaken over by one of our operators\b|\bwe've received your (?:parcel|package|item) at the parcel ?shop\b|^(?:(?:the |your )?(?:item|parcel|package|shipment) )?(?:was|has been) dropped off at (?:the |a )?parcel ?shop$|^(?![^,]*\b(?:recipient|consignee|receiver|customer|addressee|buyer|pick ?up point|parcel ?shop|locker|destination)\b)[a-z][\w&' -]{0,40} has received the goods(?:, [^,]{1,40}){0,2}\.?$|^the shipment has been deposited at a seur pickup point$|^(?:the |your )?collection (?:has been |was )?(?:carried out|completed)$|^已入库|^(?:(?:the |your )?(?:item|parcel|package|shipment) )?(?:has been |was )?put into storage$/.test(text)) return 'accepted';
  // Royal Mail's sender drop-offs at a parcel locker and a postbox, as providers relay them.
  if (/^sender advised item dropped off at parcel locker$|^dropped off at postbox$/.test(text)) return 'accepted';
  // Poste Italiane's drop-off at a Punto Poste or a Punto Poste-Locker in English ("presa in carico presso il Punto Poste").
  if (/^(?:the )?shipment has been taken over at the post (?:office|locker) point$/.test(text)) return 'accepted';
  // TNT Italy's drop-off at a FedEx Location, awaiting the courier, as providers relay it.
  if (/^spedizione affidata a una fedex location\b/.test(text)) return 'accepted';
  // The sender's drop-off at a parcel shop in German, which names the shop and its address before the verb:
  // "Die Sendung wurde vom Absender im PaketShop <shop>, <address> abgegeben".
  if (/^die sendung wurde vom absender (?:im|in der|in einem|in einer) (?:[\w-]+ )?(?:paketshop|parcelshop|filiale)\b(?!.*\bnicht\b).*\babgegeben$/.test(text)) return 'accepted';
  // The same row in English, as Hermes Germany's English route words it: "The package was dropped off by the
  // sender at the PaketShop <shop>, <address>".
  if (/^(?:the |your )?(?:package|parcel|shipment) (?:was|has been) dropped off by the sender at (?:the |a )?(?:hermes )?(?:paketshop|parcel ?shop)\b/.test(text)) return 'accepted';
  // DPD Poland's scans as ParcelsApp words them: the sender's drop-off at a pickup point, and the pickup
  // point handing the parcel to DPD's courier, not a delivery round.
  if (/^sending the (?:package|parcel) at the pick ?up point$|^handing over the (?:package|parcel) to the courier$/.test(text)) return 'accepted';
  // Its arrival at the delivering branch of the DPD country it was sent to, after the sorting centre there.
  if (/^acceptance of the (?:package|parcel) at the delivery branch abroad$/.test(text)) return 'in_transit';
  // The recipient's pickup point taking the parcel in, "Parcel collected by pickup point" on DPD Poland's own page.
  if (/^acceptance of the (?:package|parcel) at the pick ?up point$/.test(text)) return 'ready_for_pickup';
  // A forwarder's receipt at its warehouse in the sending country, as 17TRACK relays it before the
  // parcel departs that warehouse.
  if (/^(?:package|parcel) received (?:&|and) scanned at (?:the )?carrier's domestic warehouse$/.test(text)) return 'accepted';
  // The goods reaching the forwarder's receiving point, its first scan, before that warehouse receipt.
  if (/^(?:the )?goods (?:arrive|arrived|have arrived) at (?:the )?receiving point$/.test(text)) return 'accepted';
  // Admitted by the carrier: Correos's "Admitido", Correos Express's "Admitido en
  // oficina", a post's "Admisión país de origen". Admission still to come is registered above.
  if (/(?<!\b(?:no|nao) )\badmitid[oa]s?\b|\badmision (?:en origen|pais de origen)\b/.test(text)) return 'accepted';
  // Accepted by CTT: its "Aceite" state, and "O envio foi aceite" in its scans. A return request accepted is no parcel.
  if (/^aceite(?:\.|$)|\b(?:envio|objeto|objecto|encomenda|remessa) foi aceite\b/.test(text)) return 'accepted';
  // A cross-dock transfer, a flight taking off or landing, a tally in a bonded
  // warehouse, a hand-over to the last mile being prepared or to an airline, a
  // parcel bagged, unbagged or consolidated onto a master air waybill, and a
  // parcel ready for a facility's outbound dispatch or leaving a warehouse
  // move the parcel on.
  if (/\bcross ?dock(?:ed|ing)?\b|\bready for outbound\b|\b(?:un)?bagg(?:ed|ing)\b|\bmaster (?:air ?way ?bill|awb)(?: (?:number|no))? (?:received|assigned|allocated)\b|\bhand ?over to (?:the |an )?(?:airline|air carrier)\b|^(?:(?:the |your )?(?:item|parcel|package|shipment) )?(?:has )?left (?:the|our) warehouse$|\b(?:flight|leg)\b[^.;]*\b(?:is taking off|took off|has taken off|landed)\b|\bflight (?:take ?off|landing)\b|^(?:initial|final) landing$|\bcargo tally in the supervised warehouse\b|\bprepared for (?:the )?last[- ]mile hand ?over\b/.test(text)) return 'in_transit';
  // A linehaul is the trunk haul between hubs, whatever was handed over.
  // A parcel at a distribution centre, the whole scan, as Lietuvos paštas words it. Other scans naming
  // such a centre, a courier's origin scan or a retailer's order sent to its store, say less.
  if (/^(?:the |your )?(?:parcel|package|shipment|item) is (?:now )?at (?:the |a )?distribution cent(?:er|re)$/.test(text)) return 'in_transit';
  if (/transit|\bline ?haul\b|en route|on (?:its|the) way|\bfacility\b|airport|\bleaving\b|\bdispatched\b|^delay(?:ed)?$|received by (?:the )?(?:local )?(?:delivery|logistics) company|\btransfer to (?:the |a |an )?(?:local |destination )?(?:acting |delivery |logistics |courier )?(?:company|agent|carrier|partner)\b|received by (?:postnl|uniuni)\b|notification.*sent to the recipient|delivery option requested|instruction de livraison recue|cambio (?:delle )?disposizioni di consegna|expedie (?:depuis|du|de)\b|acheminement|unterwegs|\bin viaggio\b|\bw drodze\b|\bonderweg\b|transport|trasport|arriv|depart|processed|processing completed|processing at (?:the )?(?:origin |destination )?branch\b|\breceipt of (?:the )?(?:package|parcel|shipment) at (?:the )?dpd branch\b|sorted|sorting|\btri\b|\btriee?s?\b|traitement|traite|sortier|bearbeitet|bearbeitung|elaborat|elaborazion|smistat|parcel cent(?:er|re)|delivery cent(?:er|re)|centre.*(?:colis|distribution)|paketzentrum|verteilzentrum|centro.*(?:pacchi|distribuzione)|depot|import scan|scan.*import|importscan|scansione.*import|delivery.*delayed|livraison.*(?:retard|report)|zustellung.*verzogert|consegna.*ritard|transferred|transfere|weitergeleitet|inoltrato|left.*(?:point|center)|quitte|verlassen|raggiunto|close bag|fermeture du sac|sack.*geschlossen|chiusura.*sacco|scanned into|scanne dans|eingescannt|scansionat|\b(?:un)?loaded\b|^(?:item|parcel|shipment) distributed$|charg.*vehicule de transport|transportfahrzeug.*geladen|caric.*veicolo.*trasporto/.test(text)) return 'in_transit';
  if (/^enviad[oa]$|\bclasificad[oa]s?\b|\bclasificacion\b|\ben ruta\b|\ben camino\b|\bllegad[oa]s? (?:a|al|en)\b|\bllegada (?:a|al|en|de)\b|\bha llegado\b|\bllego (?:a|al)\b|\bsalida (?:de|del|desde)\b|\b(?:ha )?salido (?:de|del)\b|\bsalio (?:de|del)\b|\ben destino\b|\b(?:agencia|delegacion|plataforma|oficina|franquicia) (?:de )?destino\b|\b(?:unidad|centro|oficina|delegacion|base|agencia|plataforma) de reparto\b|\bcentro (?:de )?(?:clasificacion|distribucion|tratamiento|logistico|operaciones|operativo)\b|\blectura\b|\bleid[oa]s?\b|\brecepcionad[oa]s?\b|\bprocesad[oa]s?\b|\bexpedid[oa]s?\b|\btriagem\b|\btriad[oa]s?\b|\bem tratamento\b|\btratad[oa]s?\b|\bcentro (?:de )?(?:distribuicao|tratamento|triagem|operacional)\b|\bchegad[ao] (?:a|ao|no|na|em)\b|\bchegou (?:a|ao|no|na|em)\b|\bsaida (?:do|da|de|dos|das)\b|\bsaiu (?:do|da|de|dos|das)\b|\bem rota\b|\ba caminho\b|\bencaminhad[oa]s?\b|\b(?:em )?transferencia\b|\btransferid[oa]s?\b|\bprocessad[oa]s?\b|\brecebid[oa] (?:no|na|em) (?:centro|armazem|unidade|plataforma)\b|\brecibid[oa] en (?:el |la |nuestr[oa] )?(?:almacen|centro|delegacion|plataforma|hub|agencia)\b/.test(text)) return 'in_transit';
  return undefined;
}

export function languageStageStatus(stage: Stage): CarrierStatus {
  if (stage === 'registered' || stage === 'pending') return 'pending';
  if (stage === 'delivered') return 'delivered';
  if (stage === 'out_for_delivery' || stage === 'ready_for_pickup') return 'out_for_delivery';
  if (stage === 'returned' || stage === 'failed_attempt' || stage === 'exception') return 'exception';
  return 'in_transit';
}
