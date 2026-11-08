/** Génère une paire de clés VAPID pour les notifications push. À copier dans Render (Environment) ; ne les partage jamais. */
import webpush from "web-push";
const k = webpush.generateVAPIDKeys();
console.log("VAPID_PUBLIC_KEY=" + k.publicKey);
console.log("VAPID_PRIVATE_KEY=" + k.privateKey);
console.log("VAPID_SUBJECT=mailto:ton-adresse@exemple.com   (remplace par ton e-mail)");
