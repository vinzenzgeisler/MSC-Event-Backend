# AI Communication Hub Project Overview

Stand: 2026-04-02

## Problemstellung

Im MSC-Event-System fallen wiederkehrende, textbasierte Kommunikationsaufgaben an:

- Rueckfragen zu Nennungen, Unterlagen und Zahlungen
- Event-Kommunikation fuer Website oder Kurztexte
- kurze Sprechertexte fuer Teilnehmer oder Klassen

Diese Aufgaben sind fachlich relevant, aber zeitaufwendig und oft von verteiltem Wissen abhaengig.

## Ziel der Loesung

Der `AI Communication Hub` erweitert das System um eine cloudbasierte, review-pflichtige Assistenz fuer genau diese Kommunikationsaufgaben.

Die KI trifft keine autonomen Entscheidungen, sondern erzeugt Entwuerfe, Zusammenfassungen und Wissensvorschlaege, die fachlich geprueft werden.

## Cloud-Architektur

Technischer Kernfluss:

1. API Gateway nimmt den Request an
2. Lambda-Funktion verarbeitet den Request
3. Lambda baut serverseitig den fachlichen Kontext aus bestehenden Systemdaten
4. Lambda ruft AWS Bedrock auf
5. Das Ergebnis wird als strukturierter Entwurf mit Quellenbasis, Warnungen und Review-Hinweisen zurueckgegeben

Ergaenzend:

- IMAP-Poller auf AWS importiert eingehende Mails
- Postgres speichert Nachrichten, Drafts, Wissensvorschlaege und freigegebene Wissenseintraege

## Warum die KI-Nutzung sinnvoll ist

Die KI wird nicht beliebig, sondern dort eingesetzt, wo sie fuer den Praxispartner echten Nutzen stiftet:

- Mails schneller voranalysieren und beantworten
- wiederkehrende Kommunikationsentwuerfe beschleunigen
- vorhandenes Wissen strukturiert wiederverwendbar machen
- Transparenz ueber Datenbasis und Unsicherheit erhalten

## Fachlicher Nutzen

- weniger manueller Aufwand bei wiederkehrender Kommunikation
- bessere Nachvollziehbarkeit durch serverseitigen Kontext und Review-Hinweise
- wiederverwendbare Wissensbasis statt rein temporaerer KI-Ausgaben
- klar integrierte Cloud-Architektur mit realem Anwendungsbezug

## Bewusste Grenzen

- kein autonomer Versand oder Publishing
- kein allgemeiner offener Chatbot als Hauptfunktion
- keine Halluzinationsfoerderung durch unkontrollierte Prompts
- fehlende Daten werden markiert statt frei erfunden

## Wichtige Projektbestandteile

- Backend-Code
- AWS-Infrastruktur-Code
- Datenbankmigrationen
- API-Contract-Dokumentation
- Architektur- und Scope-Dokumentation
- Setup-/Deploy-Dokumentation
- Demo-Runbook
- Konfigurationsreferenz ohne produktive Secrets

## Kernidee

Der `AI Communication Hub` ist keine allgemeine KI-Spielerei, sondern ein realistisches Assistenzsystem fuer Event-Kommunikation, das bestehende Systemdaten mit AWS Bedrock verbindet und menschliche Review bewusst im Prozess behaelt.
