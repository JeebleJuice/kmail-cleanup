#include <Akonadi/Collection>
#include <Akonadi/CollectionCreateJob>
#include <Akonadi/CollectionFetchJob>
#include <Akonadi/Item>
#include <Akonadi/ItemMoveJob>

#include <KJob>
#include <QCoreApplication>
#include <QDate>
#include <QFile>
#include <QTextStream>

#include <algorithm>

using namespace Akonadi;

namespace {
QList<Item::Id> readIds(const QString &path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        qCritical() << "Cannot open candidate CSV:" << file.errorString();
        return {};
    }

    QList<Item::Id> ids;
    QTextStream stream(&file);
    stream.readLine(); // header
    while (!stream.atEnd()) {
        const QString line = stream.readLine();
        const auto comma = line.indexOf(u',');
        bool ok = false;
        const auto id = line.left(comma < 0 ? line.size() : comma).toLongLong(&ok);
        if (ok && id > 0) {
            ids.push_back(id);
        }
    }
    return ids;
}

Collection findReviewFolder(const Collection::List &collections, const QString &name)
{
    for (const auto &collection : collections) {
        if (collection.name() == name) {
            return collection;
        }
    }
    return {};
}
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("kmail-cleanup-move"));
    QTextStream output(stdout);

    const QStringList args = app.arguments();
    const bool apply = args.contains(QStringLiteral("--apply"));
    const QString csvPath = args.size() > 1 && !args.at(1).startsWith(QStringLiteral("--"))
        ? args.at(1)
        : QCoreApplication::applicationDirPath() + QStringLiteral("/../candidates.csv");
    const auto valueFor = [&args](const QString &option) -> QString {
        const auto index = args.indexOf(option);
        return index >= 0 && index + 1 < args.size() ? args.at(index + 1) : QString();
    };
    bool accountOk = false;
    bool inboxOk = false;
    const auto accountRootId = valueFor(QStringLiteral("--account-root")).toLongLong(&accountOk);
    const auto inboxId = valueFor(QStringLiteral("--inbox")).toLongLong(&inboxOk);
    const QString folderName = valueFor(QStringLiteral("--review-name"));
    if (!accountOk || !inboxOk || accountRootId <= 0 || inboxId <= 0 || folderName.isEmpty()) {
        qCritical() << "Required options: --account-root ID --inbox ID --review-name NAME";
        return 1;
    }
    const auto ids = readIds(csvPath);
    if (ids.isEmpty()) {
        qCritical() << "No candidate IDs loaded.";
        return 2;
    }

    CollectionFetchJob fetch(Collection(accountRootId), CollectionFetchJob::FirstLevel);
    fetch.setAutoDelete(false);
    if (!fetch.exec()) {
        qCritical() << "Cannot inspect account folders:" << fetch.errorString();
        return 3;
    }

    Collection destination = findReviewFolder(fetch.collections(), folderName);
    output << QStringLiteral("Candidates: %1\n").arg(ids.size());
    output << QStringLiteral("Source Inbox ID: %1\n").arg(inboxId);
    output << QStringLiteral("Review folder: %1 (%2)\n")
                  .arg(folderName, destination.isValid() ? QString::number(destination.id()) : QStringLiteral("not yet created"));
    output.flush();

    if (!apply) {
        output << "Dry run complete; no messages were moved.\n";
        output.flush();
        return 0;
    }

    if (!destination.isValid()) {
        Collection collection;
        collection.setParentCollection(Collection(accountRootId));
        collection.setName(folderName);
        collection.setContentMimeTypes({QStringLiteral("message/rfc822")});
        CollectionCreateJob create(collection);
        create.setAutoDelete(false);
        if (!create.exec()) {
            qCritical() << "Cannot create review folder:" << create.errorString();
            return 4;
        }
        destination = create.collection();
        output << "Created review folder with Akonadi ID " << destination.id() << "\n";
        output.flush();
    }

    constexpr qsizetype batchSize = 250;
    qsizetype moved = 0;
    for (qsizetype offset = 0; offset < ids.size(); offset += batchSize) {
        Item::List items;
        const auto end = std::min(offset + batchSize, ids.size());
        items.reserve(end - offset);
        for (qsizetype i = offset; i < end; ++i) {
            items.push_back(Item(ids.at(i)));
        }

        ItemMoveJob move(items, Collection(inboxId), destination);
        move.setAutoDelete(false);
        if (!move.exec()) {
            qCritical() << "Move stopped after" << moved << "messages:" << move.errorString();
            return 5;
        }
        moved += items.size();
        output << QStringLiteral("Moved %1 / %2\n").arg(moved).arg(ids.size());
        output.flush();
    }

    output << "Recoverable cleanup move complete.\n";
    output.flush();
    return 0;
}
